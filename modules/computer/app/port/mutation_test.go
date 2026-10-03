package port

import (
	"context"
	"errors"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"strings"
	"sync"
	"testing"
)

// This memory double proves only repository/state policy and coherent same-key
// admission in one process. It provides NO durable publication, native state,
// restart, filesystem mutation, Task/Computer admission or effect-handoff proof.
type memoryMutations struct {
	mu      sync.Mutex
	records map[mutation.Identity]mutation.State
}

var _ MutationRepository = (*memoryMutations)(nil)

func (m *memoryMutations) Admit(_ context.Context, r *mutation.State) (MutationAdmission, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r == nil || r.Phase() != mutation.Prepared {
		return MutationAdmission{}, errors.New("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED")
	}
	if m.records == nil {
		m.records = map[mutation.Identity]mutation.State{}
	}
	if existing, ok := m.records[r.Binding().Identity]; ok {
		copy := existing.Clone()
		return MutationAdmission{Status: MutationExisting, Record: &copy}, nil
	}
	copy := r.Clone()
	m.records[r.Binding().Identity] = copy
	independent := copy.Clone()
	return MutationAdmission{Status: MutationAdmitted, Record: &independent}, nil
}
func (m *memoryMutations) Load(_ context.Context, i mutation.Identity) (*mutation.State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[i]
	if !ok {
		return nil, nil
	}
	copy := r.Clone()
	return &copy, nil
}
func (m *memoryMutations) Save(_ context.Context, r *mutation.State) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r == nil {
		return errors.New("WORKSPACE_MUTATION_STATE_INVALID")
	}
	old, ok := m.records[r.Binding().Identity]
	if !ok {
		return errors.New("WORKSPACE_MUTATION_STATE_MISSING")
	}
	next, err := old.Apply(*r)
	if err != nil {
		return err
	}
	m.records[r.Binding().Identity] = next.Clone()
	return nil
}
func mutationBinding() mutation.Binding {
	return mutation.Binding{Identity: mutation.Identity{OperationID: "operation", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "main"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64)}
}
func TestMemoryMutationDoubleAdmitsOneSameKeyWithoutExecutingAnything(t *testing.T) {
	m := &memoryMutations{}
	r, err := mutation.NewPrepared(mutationBinding())
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan MutationAdmission, 16)
	failures := make(chan error, 16)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := m.Admit(context.Background(), r)
			if err != nil {
				failures <- err
				return
			}
			results <- out
		}()
	}
	wg.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	admitted, existing := 0, 0
	for out := range results {
		if out.Record == nil {
			t.Fatal("missing record")
		}
		switch out.Status {
		case MutationAdmitted:
			admitted++
		case MutationExisting:
			existing++
		default:
			t.Fatal("invalid admission")
		}
	}
	if admitted != 1 || existing != 15 {
		t.Fatalf("admitted%d existing%d", admitted, existing)
	}
	stored, err := m.Load(context.Background(), r.Binding().Identity)
	if err != nil || stored == nil {
		t.Fatal(err)
	}
	recovered, err := stored.Recover(r.Binding())
	if err != nil {
		t.Fatal(err)
	}
	unknown, ok := recovered.(mutation.InterruptedRecovery)
	if !ok {
		t.Fatal("existing prepared was treated as effect permission")
	}
	if err := m.Save(context.Background(), &unknown.Tombstone); err != nil {
		t.Fatal(err)
	}
	again, err := m.Load(context.Background(), r.Binding().Identity)
	if err != nil || again.Phase() != mutation.OutcomeUnknown {
		t.Fatal("unknown not retained")
	}
	if err := m.Save(context.Background(), r); err == nil {
		t.Fatal("unknown reopened")
	}
}
func TestMemoryMutationDoublePreservesBindingAndIndependentReceipt(t *testing.T) {
	m := &memoryMutations{}
	r, err := mutation.NewPrepared(mutationBinding())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Admit(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	b := mutationBinding()
	b.RequestDigest = strings.Repeat("b", 64)
	changed, err := mutation.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	out, err := m.Admit(context.Background(), changed)
	if err != nil || out.Status != MutationExisting {
		t.Fatal("same identity not found")
	}
	if recovery, err := out.Record.Recover(b); err == nil || recovery != nil {
		t.Fatal("digest conflict became execution")
	}
	before := strings.Repeat("a", 64)
	done, err := r.Complete(mutation.Receipt{Operation: mutation.WriteKind, RelativePath: "a", BeforeSHA256: &before, AfterSHA256: strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Save(context.Background(), done); err != nil {
		t.Fatal(err)
	}
	got, err := m.Load(context.Background(), r.Binding().Identity)
	if err != nil {
		t.Fatal(err)
	}
	*got.Receipt().BeforeSHA256 = strings.Repeat("c", 64)
	got, err = m.Load(context.Background(), r.Binding().Identity)
	if err != nil || *got.Receipt().BeforeSHA256 != before {
		t.Fatal("load alias")
	}
	if err := m.Save(context.Background(), done); err != nil {
		t.Fatal("identical terminal save refused")
	}
}

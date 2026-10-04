package mutation

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestOwnerRepositoryChangedBindingIsExistingConflictWithoutPublication(t *testing.T) {
	for _, phase := range []domain.Phase{domain.Prepared, domain.Completed, domain.Failed, domain.OutcomeUnknown} {
		t.Run(string(phase), func(t *testing.T) {
			r, m, s := ownerFixture(t)
			ctx := context.Background()
			admitted(t, r, s)
			stored := s
			var err error
			switch phase {
			case domain.Completed:
				stored = completed(t, s)
			case domain.Failed:
				stored, err = s.Refuse(domain.Failure{Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", Source: "authority-store"})
			case domain.OutcomeUnknown:
				stored, err = s.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = r.Save(ctx, stored); err != nil {
				t.Fatal(err)
			}
			key, err := recordKey(s.Binding().Identity)
			if err != nil {
				t.Fatal(err)
			}
			before := bytes.Clone(m.files[key])
			creates, replaces := m.creates, m.replaces
			for name, change := range map[string]func(*domain.Binding){
				"generation":      func(b *domain.Binding) { b.ComputerGeneration++ },
				"zero-generation": func(b *domain.Binding) { b.ComputerGeneration = 0 },
				"workspace":       func(b *domain.Binding) { b.WorkspaceID = "other" },
				"digest":          func(b *domain.Binding) { b.RequestDigest = strings.Repeat("c", 64) },
			} {
				t.Run(name, func(t *testing.T) {
					b := s.Binding()
					change(&b)
					next, err := domain.NewPrepared(b)
					if err != nil {
						t.Fatal(err)
					}
					a, err := r.Admit(ctx, next)
					if err != nil || a.Status != port.MutationExisting || a.Record == nil || a.Record.Binding() != s.Binding() || a.Record.Phase() != phase {
						t.Fatalf("changed binding minted permit/lost existing fact: %#v %v", a, err)
					}
					out, err := a.Record.Recover(b)
					var classified *authority.Failure
					if out != nil || !errors.As(err, &classified) || classified.Code != "COMPUTER_MUTATION_OPERATION_CONFLICT" || classified.Source != "operation-store" {
						t.Fatalf("changed binding did not conflict: %v %v", out, err)
					}
					code(t, r.Save(ctx, completed(t, next)), "WORKSPACE_MUTATION_BINDING_MISMATCH")
					if m.creates != creates || m.replaces != replaces || !bytes.Equal(m.files[key], before) || r.fenced {
						t.Fatal("binding conflict changed publication/storage state")
					}
				})
			}
			// A new injected observer sees the same original binding. This is not
			// native reopen/restart qualification and never permits effects.
			observer := newRepository(m)
			a, err := observer.Admit(ctx, s)
			if err != nil || a.Status != port.MutationExisting || a.Record.Binding() != stored.Binding() || a.Record.Phase() != phase {
				t.Fatal("owner observer acquired execution", err)
			}
			loaded, err := observer.Load(ctx, s.Binding().Identity)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = stored.Apply(*loaded); err != nil || m.creates != creates || m.replaces != replaces {
				t.Fatal("observation changed terminal fact or storage", err)
			}
		})
	}
}

func TestOwnerRepositoryConcurrentGenerationsHaveOneFreshPermit(t *testing.T) {
	r, m, s := ownerFixture(t)
	type result struct {
		binding   domain.Binding
		admission port.MutationAdmission
		err       error
	}
	results := make(chan result, 24)
	var wg sync.WaitGroup
	for n := range 24 {
		b := s.Binding()
		b.ComputerGeneration = uint64(n)
		next, err := domain.NewPrepared(b)
		if err != nil {
			t.Fatal(err)
		}
		wg.Go(func() {
			a, err := r.Admit(context.Background(), next)
			results <- result{binding: b, admission: a, err: err}
		})
	}
	wg.Wait()
	close(results)
	loaded, err := r.Load(context.Background(), s.Binding().Identity)
	if err != nil || loaded == nil {
		t.Fatal("owner record missing", err)
	}
	fresh := 0
	for v := range results {
		if v.err != nil || v.admission.Record == nil || v.admission.Record.Binding() != loaded.Binding() {
			t.Fatal("generation race did not coalesce", v.err)
		}
		switch v.admission.Status {
		case port.MutationAdmitted:
			fresh++
			if v.binding != loaded.Binding() {
				t.Fatal("admitted a different binding")
			}
		case port.MutationExisting:
		default:
			t.Fatal(v.admission.Status)
		}
	}
	if fresh != 1 || m.creates != 1 || m.replaces != 0 || len(m.files) != 1 {
		t.Fatalf("fresh=%d creates=%d replaces=%d files=%d", fresh, m.creates, m.replaces, len(m.files))
	}
}

func TestOwnerRepositoryTaskAndOwnerKeysStaySeparateAndCrossingFails(t *testing.T) {
	r, m, owner := ownerFixture(t)
	_, _, task := fixture()
	ctx := context.Background()
	admitted(t, r, task)
	admitted(t, r, owner)
	ownerKey, err := recordKey(owner.Binding().Identity)
	if err != nil {
		t.Fatal(err)
	}
	taskKey, err := recordKey(task.Binding().Identity)
	if err != nil || ownerKey == taskKey || m.creates != 2 || len(m.files) != 2 {
		t.Fatal("owner and task records shared a key")
	}
	ownerBytes, taskBytes := bytes.Clone(m.files[ownerKey]), bytes.Clone(m.files[taskKey])
	for _, s := range []*domain.State{owner, task} {
		a, err := r.Admit(ctx, s)
		if err != nil || a.Status != port.MutationExisting || a.Record.Binding() != s.Binding() {
			t.Fatal("scopes interfered", err)
		}
	}
	m.files[ownerKey], m.files[taskKey] = taskBytes, ownerBytes
	for _, s := range []*domain.State{owner, task} {
		got, err := r.Load(ctx, s.Binding().Identity)
		if got != nil {
			t.Fatal("crossed identity returned")
		}
		code(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
		_, err = r.Admit(ctx, s)
		code(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	if m.creates != 2 || m.replaces != 0 {
		t.Fatal("crossed records repaired or created")
	}
}

func TestOwnerRepositoryRejectsMixedKeysAndCorruptionWithoutEffects(t *testing.T) {
	r, m, s := ownerFixture(t)
	for _, change := range []func(*domain.Identity){
		func(i *domain.Identity) { i.Scope = "" },
		func(i *domain.Identity) { i.Scope = "task" },
		func(i *domain.Identity) { i.ProfileID = "" },
		func(i *domain.Identity) { i.ComputerID = "" },
		func(i *domain.Identity) { i.SessionID = "session" },
		func(i *domain.Identity) { i.TaskID = "task" },
		func(i *domain.Identity) { i.TaskEpoch = 1 },
		func(i *domain.Identity) { i.ParticipantID = "participant" },
	} {
		id := s.Binding().Identity
		change(&id)
		key, err := recordKey(id)
		if key != "" {
			t.Fatal("invalid identity got a key")
		}
		code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
		got, err := r.Load(context.Background(), id)
		if got != nil {
			t.Fatal("invalid identity loaded")
		}
		code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	}
	if m.reads != 0 || m.checks != 0 || m.creates != 0 || m.replaces != 0 {
		t.Fatal("invalid identity reached storage")
	}
	admitted(t, r, s)
	key, _ := recordKey(s.Binding().Identity)
	raw := bytes.Clone(m.files[key])
	m.files[key] = bytes.Replace(raw, []byte(`"computerGeneration":7`), []byte(`"computerGeneration":7.0`), 1)
	got, err := r.Load(context.Background(), s.Binding().Identity)
	if got != nil {
		t.Fatal("corrupt owner record returned")
	}
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	_, err = r.Admit(context.Background(), s)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	if m.creates != 1 || m.replaces != 0 || bytes.Equal(m.files[key], raw) {
		t.Fatal("corrupt owner record repaired/readmitted")
	}
}

package mutation

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Byte store only. No New/native storage, real files, profiles or processes.
// Visibility and durable acknowledgement are deliberately separate fault points.
type memory struct {
	files                                              map[string][]byte
	reads, creates, replaces, checks, closes           int
	createErr, replaceErr, readErr, checkErr, closeErr error
	visibleBeforeError                                 bool
	afterCreate, afterReplace, afterRead               func()
	crossed                                            bool
}

func fixture() (*Repository, *memory, *domain.State) {
	m := &memory{files: make(map[string][]byte)}
	b := domain.Binding{Identity: domain.Identity{OperationID: "op", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "participant"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64)}
	s, err := domain.NewPrepared(b)
	if err != nil {
		panic(err)
	}
	return newRepository(m), m, s
}
func (m *memory) check() error { m.checks++; return m.checkErr }
func (m *memory) read(key string) ([]byte, error) {
	m.reads++
	v := bytes.Clone(m.files[key])
	if m.afterRead != nil {
		m.afterRead()
	}
	return v, m.readErr
}
func (m *memory) create(key string, raw []byte) error {
	m.creates++
	if _, ok := m.files[key]; ok {
		return errExists
	}
	if m.createErr == nil || m.visibleBeforeError {
		m.files[key] = bytes.Clone(raw)
	}
	if m.crossed {
		m.files[key] = []byte("crossed")
	}
	if m.afterCreate != nil {
		m.afterCreate()
	}
	return m.createErr
}
func (m *memory) replace(key string, raw, previous []byte) error {
	m.replaces++
	if !bytes.Equal(m.files[key], previous) {
		return errors.New("crossed preimage")
	}
	if m.replaceErr == nil || m.visibleBeforeError {
		m.files[key] = bytes.Clone(raw)
	}
	if m.afterReplace != nil {
		m.afterReplace()
	}
	return m.replaceErr
}
func (m *memory) close() error { m.closes++; return m.closeErr }
func completed(t *testing.T, s *domain.State) *domain.State {
	t.Helper()
	r, err := s.Complete(domain.Receipt{Operation: domain.WriteKind, RelativePath: "file.md", Bytes: 12, AfterSHA256: strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func code(t *testing.T, err error, want string) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != want || f.Retry() != "never" {
		t.Fatalf("got %v, want %s", err, want)
	}
}
func admitted(t *testing.T, r *Repository, s *domain.State) {
	t.Helper()
	a, err := r.Admit(context.Background(), s)
	if err != nil || a.Status != port.MutationAdmitted || a.Record == nil || a.Record.Binding() != s.Binding() {
		t.Fatalf("admit: %#v %v", a, err)
	}
}
func TestFreshExistingSaveAndReadOnlyLoad(t *testing.T) {
	r, m, s := fixture()
	ctx := context.Background()
	before := m.creates + m.replaces
	got, err := r.Load(ctx, s.Binding().Identity)
	if err != nil || got != nil || m.creates+m.replaces != before {
		t.Fatal("missing Load performed effects")
	}
	admitted(t, r, s)
	a, err := r.Admit(ctx, s)
	if err != nil || a.Status != port.MutationExisting || m.creates != 1 {
		t.Fatal("duplicate permits execution")
	}
	changed := s.Binding()
	changed.RequestDigest = strings.Repeat("c", 64)
	changed.WorkspaceID = "other"
	other, _ := domain.NewPrepared(changed)
	a, err = r.Admit(ctx, other)
	if err != nil || a.Status != port.MutationExisting || a.Record.Binding() != s.Binding() || m.creates != 1 {
		t.Fatal("same key overwritten")
	}
	final := completed(t, s)
	if err = r.Save(ctx, final); err != nil {
		t.Fatal(err)
	}
	if err = r.Save(ctx, final); err != nil || m.replaces != 1 {
		t.Fatal("same terminal Save wrote again")
	}
	got, err = r.Load(ctx, s.Binding().Identity)
	if err != nil || got.Phase() != domain.Completed || got.Receipt().AfterSHA256 != final.Receipt().AfterSHA256 {
		t.Fatal("terminal lost")
	}
	h := "changed"
	clone := got.Receipt()
	clone.BeforeSHA256 = &h
	got, err = r.Load(ctx, s.Binding().Identity)
	if err != nil || got.Receipt().BeforeSHA256 != nil {
		t.Fatal("Load aliased storage")
	}
	a, err = r.Admit(ctx, s)
	if err != nil || a.Status != port.MutationExisting || a.Record.Phase() != domain.Completed || m.creates != 1 {
		t.Fatal("completed was reopened")
	}
}
func TestConcurrentExactKeyHasOneFreshPermit(t *testing.T) {
	r, m, s := fixture()
	statuses := make(chan port.MutationAdmissionStatus, 24)
	errs := make(chan error, 24)
	var wg sync.WaitGroup
	for range 24 {
		wg.Go(func() { a, err := r.Admit(context.Background(), s); statuses <- a.Status; errs <- err })
	}
	wg.Wait()
	close(statuses)
	close(errs)
	fresh := 0
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for status := range statuses {
		if status == port.MutationAdmitted {
			fresh++
		} else if status != port.MutationExisting {
			t.Fatal(status)
		}
	}
	if fresh != 1 || m.creates != 1 {
		t.Fatalf("fresh=%d writes=%d", fresh, m.creates)
	}
}
func TestUncertainAdmitFencesBeforeAndAfterVisibility(t *testing.T) {
	for _, visible := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "after"}[visible], func(t *testing.T) {
			r, m, s := fixture()
			m.createErr = errors.New("lost ack")
			m.visibleBeforeError = visible
			a, err := r.Admit(context.Background(), s)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if a.Record != nil || a.Status != "" {
				t.Fatal("unknown returned permit")
			}
			_, err = r.Admit(context.Background(), s)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, err = r.Load(context.Background(), s.Binding().Identity)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			err = r.Save(context.Background(), completed(t, s))
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if m.creates != 1 || m.replaces != 0 {
				t.Fatal("unknown retried")
			}
		})
	}
}
func TestSaveUncertaintyDoesNotReclassifyOrRetry(t *testing.T) {
	for _, visible := range []bool{false, true} {
		r, m, s := fixture()
		admitted(t, r, s)
		m.replaceErr = errors.New("lost terminal ack")
		m.visibleBeforeError = visible
		final := completed(t, s)
		code(t, r.Save(context.Background(), final), "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
		code(t, r.Save(context.Background(), final), "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
		_, err := r.Load(context.Background(), s.Binding().Identity)
		code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
		if m.replaces != 1 {
			t.Fatal("Save retried")
		}
		key, _ := recordKey(s.Binding().Identity)
		seen, err := decode(m.files[key])
		if err != nil || visible && seen.Phase() != domain.Completed || !visible && seen.Phase() != domain.Prepared {
			t.Fatal("unknown bytes were repaired")
		}
	}
}
func TestCancellationPublicationAndCrossedAck(t *testing.T) {
	for _, phase := range []string{"cancel-admit", "crossed-admit", "check-admit", "cancel-save"} {
		t.Run(phase, func(t *testing.T) {
			r, m, s := fixture()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch phase {
			case "cancel-admit":
				m.afterCreate = cancel
			case "crossed-admit":
				m.crossed = true
			case "check-admit":
				m.afterCreate = func() { m.checkErr = errors.New("root changed") }
			case "cancel-save":
				admitted(t, r, s)
				m.afterReplace = cancel
			}
			var err error
			if phase == "cancel-save" {
				err = r.Save(ctx, completed(t, s))
			} else {
				_, err = r.Admit(ctx, s)
			}
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if !r.fenced {
				t.Fatal("uncertainty not fenced")
			}
		})
	}
	r, m, s := fixture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := r.Admit(ctx, s)
	code(t, err, "WORKSPACE_MUTATION_CANCELLED")
	if m.creates != 0 || m.reads != 0 {
		t.Fatal("cancel before intent wrote")
	}
	r, m, s = fixture()
	admitted(t, r, s)
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	m.afterRead = cancel
	_, err = r.Admit(ctx, s)
	code(t, err, "WORKSPACE_MUTATION_CANCELLED")
}
func TestPreparedRestartIsObservationOnly(t *testing.T) {
	r, m, s := fixture()
	admitted(t, r, s)
	// Independent injected successor observation, NOT native reopen qualification.
	successor := newRepository(m)
	a, err := successor.Admit(context.Background(), s)
	if err != nil || a.Status != port.MutationExisting || a.Record.Phase() != domain.Prepared || m.creates != 1 {
		t.Fatal("restart minted permit")
	}
	got, err := successor.Load(context.Background(), s.Binding().Identity)
	if err != nil || got.Phase() != domain.Prepared || m.replaces != 0 {
		t.Fatal("prepared observer tombstoned active peer")
	}
	if err = r.Save(context.Background(), completed(t, s)); err != nil {
		t.Fatal(err)
	}
	got, err = successor.Load(context.Background(), s.Binding().Identity)
	if err != nil || got.Phase() != domain.Completed {
		t.Fatal("same-key terminal could not be observed")
	}
}
func TestTerminalImmutabilityBindingAndInvalidStorage(t *testing.T) {
	r, m, s := fixture()
	code(t, r.Save(context.Background(), completed(t, s)), "WORKSPACE_MUTATION_STATE_MISSING")
	admitted(t, r, s)
	b := s.Binding()
	b.WorkspaceID = "changed"
	changed, _ := domain.NewPrepared(b)
	code(t, r.Save(context.Background(), completed(t, changed)), "WORKSPACE_MUTATION_BINDING_MISMATCH")
	if err := r.Save(context.Background(), completed(t, s)); err != nil {
		t.Fatal(err)
	}
	denied, _ := s.Refuse(domain.Failure{Code: "AUTHORITY_PATH_DENIED", Source: "task-grant"})
	code(t, r.Save(context.Background(), denied), "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	code(t, r.Save(context.Background(), s), "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	key, _ := recordKey(s.Binding().Identity)
	m.files[key] = []byte("bad bytes")
	_, err := r.Load(context.Background(), s.Binding().Identity)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	if m.replaces != 1 {
		t.Fatal("invalid observation performed repair")
	}
}
func TestReadErrorIsNotAbsenceAndCloseRetainsFailure(t *testing.T) {
	r, m, s := fixture()
	m.readErr = errors.New("permission")
	got, err := r.Load(context.Background(), s.Binding().Identity)
	code(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	if got != nil || m.creates != 0 {
		t.Fatal("failed read became absence")
	}
	m.closeErr = errors.New("close failed")
	code(t, r.Close(), "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	code(t, r.Close(), "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	if m.closes != 1 {
		t.Fatal("Close repeated")
	}
	_, err = r.Load(context.Background(), s.Binding().Identity)
	code(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
}

func TestRacingCreateAlwaysReturnsExistingOrUnknown(t *testing.T) {
	for _, visible := range []bool{true, false} {
		r, m, s := fixture()
		m.createErr = errExists
		m.visibleBeforeError = visible
		a, err := r.Admit(context.Background(), s)
		if visible {
			if err != nil || a.Status != port.MutationExisting || a.Record == nil {
				t.Fatal("race became fresh permit")
			}
		} else {
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if a.Record != nil || !r.fenced {
				t.Fatal("missing race acknowledgement admitted")
			}
		}
		if m.creates != 1 {
			t.Fatal("raced create repeated")
		}
	}
}
func TestExactIdentityComponentsAndStoredCrossing(t *testing.T) {
	r, m, s := fixture()
	admitted(t, r, s)
	original, _ := recordKey(s.Binding().Identity)
	variants := []domain.Identity{s.Binding().Identity, s.Binding().Identity, s.Binding().Identity, s.Binding().Identity, s.Binding().Identity, s.Binding().Identity}
	variants[0].OperationID = "other"
	variants[1].OwnerID = "other"
	variants[2].SessionID = "other"
	variants[3].TaskID = "other"
	variants[4].TaskEpoch++
	variants[5].ParticipantID = "other"
	for _, id := range variants {
		key, err := recordKey(id)
		if err != nil || key == original {
			t.Fatal("identity component absent from key")
		}
		// Deliberately put another identity's valid record at the requested filename.
		m.files[key] = bytes.Clone(m.files[original])
		_, err = r.Load(context.Background(), id)
		code(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
}
func TestV1UnsupportedTerminalDoesNotRewriteKnownRecord(t *testing.T) {
	r, m, s := fixture()
	admitted(t, r, s)
	f, err := s.Refuse(domain.Failure{Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", Source: "authority-store"})
	if err != nil {
		t.Fatal(err)
	}
	code(t, r.Save(context.Background(), f), "WORKSPACE_MUTATION_STATE_INVALID")
	if m.replaces != 0 || r.fenced {
		t.Fatal("format limit changed storage or publication state")
	}
}

func TestEEXISTMissingObservationCannotBecomeFreshPermit(t *testing.T) {
	r, m, s := fixture()
	key, err := recordKey(s.Binding().Identity)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encode(s)
	if err != nil {
		t.Fatal(err)
	}
	m.createErr = errExists
	m.afterRead = func() {
		if m.reads == 2 {
			// The EEXIST observation has already captured nil. The matching Prepared
			// appears only after that read, so a later read must never mint a permit.
			m.files[key] = bytes.Clone(raw)
		}
	}
	a, err := r.Admit(context.Background(), s)
	if err == nil || a.Status != "" || a.Record != nil {
		t.Fatalf("EEXIST with missing observation returned status=%q record=%v err=%v reads=%d", a.Status, a.Record != nil, err, m.reads)
	}
	code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if !r.fenced || m.reads != 2 || m.creates != 1 || m.replaces != 0 {
		t.Fatalf("unsettled EEXIST fell through: fenced=%v reads=%d creates=%d replaces=%d", r.fenced, m.reads, m.creates, m.replaces)
	}
	reads, checks := m.reads, m.checks
	_, err = r.Admit(context.Background(), s)
	code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	_, err = r.Load(context.Background(), s.Binding().Identity)
	code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	code(t, r.Save(context.Background(), completed(t, s)), "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if m.reads != reads || m.checks != checks || m.creates != 1 || m.replaces != 0 {
		t.Fatal("fenced EEXIST performed another observation or publication")
	}
}

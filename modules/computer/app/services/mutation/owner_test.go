package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Pure injected approval, clock, repository and native observations. No host
// IO, normal startup, transport, disk durability or packaged claim is made.
type ownerSource struct {
	approval authority.Approval
	calls    int
	marker   *testLease
	hook     func(int)
	callback func(func(*authority.Approval) error) error
}

func (p *ownerSource) WithCurrent(_ context.Context, inspect func(*authority.Approval) error) error {
	p.calls++
	if p.hook != nil {
		p.hook(p.calls)
	}
	p.marker.inside = true
	defer func() { p.marker.inside = false }()
	if p.callback != nil {
		return p.callback(inspect)
	}
	copy := p.approval.Clone()
	return inspect(&copy)
}

type ownerDigest struct{}

func (ownerDigest) Digest(in port.MutationDigestInput) (string, error) {
	if v, ok := in.Operation.(state.Write); ok && v.Content == "different" {
		return strings.Repeat("b", 64), nil
	}
	return strings.Repeat("a", 64), nil
}

type ownerFixture struct {
	service  *OwnerService
	selected OwnerSelection
	source   *ownerSource
	clock    *testClock
	store    *testStore
	native   *testNative
	request  OwnerRequest
}

func newOwnerFixture(t *testing.T) ownerFixture {
	t.Helper()
	now := time.UnixMilli(1800000000000)
	clock := &testClock{now}
	marker := &testLease{}
	source := &ownerSource{marker: marker, approval: authority.Approval{
		OwnerID: "owner", ComputerID: "computer", Generation: 7, ExpiresAt: now.Add(time.Hour),
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "7", Inode: "2"}}},
		Capabilities: []authority.Capability{authority.Write}, Network: authority.NoNetwork, Commands: authority.NoCommands,
	}}
	store, native := &testStore{lease: marker}, &testNative{lease: marker}
	selected := OwnerSelection{OperationID: "operation", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer", ComputerGeneration: 7}
	svc, err := NewForOwnerExecution(context.Background(), selected, source, store, native, ownerDigest{}, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	return ownerFixture{svc, selected, source, clock, store, native, OwnerRequest{WorkspaceID: "work", Operation: Write{RelativePath: "note.md", Content: "new"}}}
}
func (f ownerFixture) restart(t *testing.T) *OwnerService {
	t.Helper()
	svc, err := NewForOwnerExecution(context.Background(), f.selected, f.source, f.store, f.native, ownerDigest{}, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	return svc
}
func TestOwnerMutationUsesOneEngineAndExactOwnerIdentity(t *testing.T) {
	f := newOwnerFixture(t)
	for i := 0; i < 2; i++ {
		out, err := f.service.Execute(context.Background(), f.request)
		if err != nil || out.Phase != "completed" || out.Publication != "durable" || out.ComputerGeneration != 7 || out.OperationID != f.selected.OperationID {
			t.Fatalf("%#v %v", out, err)
		}
		out.Receipt.AfterSHA256 = "corrupt caller copy"
	}
	b := f.store.record.Binding()
	if b.Identity != f.selected.identity() || b.Identity.Scope != state.ScopeOwnerSettings || b.Identity.TaskID != "" || b.Identity.SessionID != "" || b.Identity.ParticipantID != "" || b.ComputerGeneration != 7 || f.native.calls != 1 || f.store.admissions != 1 || f.store.saves != 1 {
		t.Fatalf("not one exact owner attempt: %#v", b)
	}
	out, err := f.restart(t).Execute(context.Background(), f.request)
	if err != nil || out.Receipt.AfterSHA256 != strings.Repeat("c", 64) || f.native.calls != 1 || f.store.saves != 1 {
		t.Fatalf("replayed or aliased %#v %v", out, err)
	}
}
func TestOwnerMutationApprovalGuardsBeforeAdmissionAndPublication(t *testing.T) {
	changes := map[string]func(*ownerFixture){
		"owner":            func(f *ownerFixture) { f.source.approval.OwnerID = "other" },
		"computer":         func(f *ownerFixture) { f.source.approval.ComputerID = "other" },
		"generation":       func(f *ownerFixture) { f.source.approval.Generation++ },
		"write access":     func(f *ownerFixture) { f.source.approval.Workspaces[0].Access = authority.ReadAccess },
		"write capability": func(f *ownerFixture) { f.source.approval.Capabilities = []authority.Capability{authority.Read} },
		"root identity":    func(f *ownerFixture) { f.source.approval.Workspaces[0].RootIdentity.Inode = "8" },
		"exclusion": func(f *ownerFixture) {
			f.source.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/note.md"}}
		},
		"lease":          func(f *ownerFixture) { f.clock.now = f.clock.now.Add(15 * time.Second) },
		"renewed expiry": func(f *ownerFixture) { f.source.approval.ExpiresAt = f.source.approval.ExpiresAt.Add(time.Hour) },
	}
	for name, change := range changes {
		for _, stage := range []string{"before admission", "after admission", "native guard", "disclosure"} {
			t.Run(name+"/"+stage, func(t *testing.T) {
				f := newOwnerFixture(t)
				switch stage {
				case "before admission":
					change(&f)
				case "after admission":
					f.store.admitHook = func() { change(&f) }
				case "native guard", "disclosure":
					f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
						if stage == "native guard" {
							change(&f)
						}
						if err := r.BeforePublish(ctx); err != nil {
							return nil, err
						}
						if stage == "disclosure" {
							change(&f)
						}
						return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
					}
				}
				out, err := f.service.Execute(context.Background(), f.request)
				if out != nil || err == nil {
					t.Fatalf("revoked owner disclosed: %#v %v", out, err)
				}
				if stage == "before admission" && (f.store.admissions != 0 || f.native.calls != 0) {
					t.Fatal("unauthorized admission")
				}
				if stage == "after admission" && f.native.calls != 0 {
					t.Fatal("missed pre-dispatch guard")
				}
				if stage == "native guard" && f.store.record.Phase() != state.Failed {
					t.Fatal("guard refusal lost")
				}
				if stage == "disclosure" && f.store.record.Phase() != state.Completed {
					t.Fatal("lost known completion")
				}
				calls := f.native.calls
				_, _ = f.service.Execute(context.Background(), f.request)
				if calls != f.native.calls {
					t.Fatal("replayed after authority changed")
				}
			})
		}
	}
}
func TestOwnerMutationConstructorAndRequestsCannotMintAuthority(t *testing.T) {
	for _, change := range []func(*OwnerSelection){
		func(s *OwnerSelection) { s.OwnerID = "other" }, func(s *OwnerSelection) { s.ComputerID = "other" }, func(s *OwnerSelection) { s.ComputerGeneration++ },
		func(s *OwnerSelection) { s.ProfileID = "" }, func(s *OwnerSelection) { s.OperationID = "" }, func(s *OwnerSelection) { s.ComputerGeneration = state.MaxSafeInteger + 1 },
	} {
		f := newOwnerFixture(t)
		change(&f.selected)
		out, err := NewForOwnerExecution(context.Background(), f.selected, f.source, f.store, f.native, ownerDigest{}, &sync.Mutex{}, f.clock)
		if out != nil || err == nil || f.store.admissions != 0 || f.native.calls != 0 {
			t.Fatal("unbound constructor admitted")
		}
	}
	for _, r := range []OwnerRequest{{}, {WorkspaceID: "work", Operation: Write{RelativePath: "../escape", Content: "new"}}, {WorkspaceID: "other", Operation: Write{RelativePath: "note.md", Content: "new"}}} {
		f := newOwnerFixture(t)
		out, err := f.service.Execute(context.Background(), r)
		if out != nil || err == nil || f.store.admissions != 0 || f.native.calls != 0 {
			t.Fatal("invalid request admitted")
		}
	}
}
func TestOwnerMutationCurrentPortMustSettleExactlyOnce(t *testing.T) {
	for _, mode := range []string{"skip", "twice", "swallow", "late error", "mutated", "nil", "late callback"} {
		t.Run(mode, func(t *testing.T) {
			f := newOwnerFixture(t)
			var late func(*authority.Approval) error
			f.source.callback = func(inspect func(*authority.Approval) error) error {
				a := f.source.approval.Clone()
				switch mode {
				case "skip":
					return nil
				case "twice":
					_ = inspect(&a)
					_ = inspect(&a)
					return nil
				case "swallow":
					a.Generation++
					_ = inspect(&a)
					return nil
				case "late error":
					_ = inspect(&a)
					return errors.New("private store diagnostic")
				case "mutated":
					_ = inspect(&a)
					a.Generation++
					return nil
				case "nil":
					_ = inspect(nil)
					return nil
				case "late callback":
					late = inspect
					return nil
				}
				return nil
			}
			out, err := f.service.Execute(context.Background(), f.request)
			if out != nil || err == nil || f.store.admissions != 0 || f.native.calls != 0 {
				t.Fatal("invalid owner callback admitted")
			}
			if late != nil && late(&f.source.approval) == nil {
				t.Fatal("late callback accepted")
			}
		})
	}
}
func TestOwnerMutationLostAdmissionAndTerminalACKNeverRepeat(t *testing.T) {
	f := newOwnerFixture(t)
	f.store.admitErr = errors.New("lost admission ACK")
	for i := 0; i < 2; i++ {
		_, err := f.service.Execute(context.Background(), f.request)
		requireCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	}
	if f.store.admissions != 1 || f.native.calls != 0 {
		t.Fatal("retried uncertain admission")
	}
	_, observeErr := f.service.Observe(context.Background(), OwnerObservation{"work", "note.md"})
	requireCode(t, observeErr, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if f.store.loads != 0 {
		t.Fatal("lost admission downgraded by an apparently empty record")
	}
	f = newOwnerFixture(t)
	f.store.saveErr = errors.New("lost terminal ACK")
	for i := 0; i < 2; i++ {
		out, err := f.service.Execute(context.Background(), f.request)
		if err != nil || out.Publication != "memory_only" || out.Phase != "completed" {
			t.Fatalf("%#v %v", out, err)
		}
	}
	f.clock.now = f.clock.now.Add(time.Hour)
	out, err := f.service.Observe(context.Background(), OwnerObservation{"work", "note.md"})
	if err != nil || out.Publication != "memory_only" || out.Phase != "completed" {
		t.Fatalf("lost memory result %#v %v", out, err)
	}
	observer, err := NewOwnerObserver(f.selected, f.store)
	if err != nil {
		t.Fatal(err)
	}
	out, err = observer.Observe(context.Background(), OwnerObservation{"work", "note.md"})
	if err != nil || out.Phase != "outcome_unknown" || out.Publication != "durable" || f.native.calls != 1 || f.store.saves != 1 || f.store.admissions != 1 {
		t.Fatalf("restarted prepared %#v %v", out, err)
	}
}
func TestOwnerMutationChangedGenerationOrPayloadConflictsWithoutNewEffect(t *testing.T) {
	for _, name := range []string{"generation", "payload", "workspace"} {
		t.Run(name, func(t *testing.T) {
			f := newOwnerFixture(t)
			if _, err := f.service.Execute(context.Background(), f.request); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "generation":
				f.selected.ComputerGeneration++
				f.source.approval.Generation++
			case "payload":
				f.request.Operation = Write{RelativePath: "note.md", Content: "different"}
			case "workspace":
				f.request.WorkspaceID = "other"
				f.source.approval.Workspaces[0].WorkspaceID = "other"
			}
			_, err := f.restart(t).Execute(context.Background(), f.request)
			requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
			if f.native.calls != 1 || f.store.saves != 1 {
				t.Fatal("changed binding executed")
			}
		})
	}
}
func TestOwnerObservationAfterRevocationIsReadOnlyAndExact(t *testing.T) {
	f := newOwnerFixture(t)
	if _, err := f.service.Execute(context.Background(), f.request); err != nil {
		t.Fatal(err)
	}
	f.clock.now = f.clock.now.Add(time.Hour)
	f.source.approval.Generation++
	f.source.approval.Capabilities = nil
	observer, _ := NewOwnerObserver(f.selected, f.store)
	for i := 0; i < 2; i++ {
		out, err := observer.Observe(context.Background(), OwnerObservation{"work", "note.md"})
		if err != nil || out.Phase != "completed" {
			t.Fatalf("%#v %v", out, err)
		}
		out.Receipt.RelativePath = "other"
	}
	for _, change := range []func(*OwnerSelection){func(s *OwnerSelection) { s.ProfileID = "other" }, func(s *OwnerSelection) { s.ComputerID = "other" }, func(s *OwnerSelection) { s.OwnerID = "other" }, func(s *OwnerSelection) { s.OperationID = "other" }, func(s *OwnerSelection) { s.ComputerGeneration++ }} {
		x := f.selected
		change(&x)
		o, _ := NewOwnerObserver(x, f.store)
		_, err := o.Observe(context.Background(), OwnerObservation{"work", "note.md"})
		requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
	}
	for _, request := range []OwnerObservation{{"other", "note.md"}, {"work", "other.md"}} {
		_, err := observer.Observe(context.Background(), request)
		requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
	}
	if f.native.calls != 1 || f.store.saves != 1 || f.store.admissions != 1 {
		t.Fatal("observation had effects")
	}
}
func TestOwnerObservationMissingPreparedCorruptAndLaterPeerCompletion(t *testing.T) {
	f := newOwnerFixture(t)
	observer, _ := NewOwnerObserver(f.selected, f.store)
	_, err := observer.Observe(context.Background(), OwnerObservation{"work", "note.md"})
	requireCode(t, err, "COMPUTER_MUTATION_OPERATION_NOT_FOUND")
	b := state.Binding{Identity: f.selected.identity(), ComputerGeneration: 7, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64)}
	prepared, _ := state.NewPrepared(b)
	f.store.record = prepared
	out, err := f.service.Execute(context.Background(), f.request)
	if err != nil || out.Phase != "outcome_unknown" {
		t.Fatalf("%#v %v", out, err)
	}
	terminal, _ := prepared.Complete(state.Receipt{Operation: state.WriteKind, RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)})
	f.store.record = terminal
	out, err = f.service.Observe(context.Background(), OwnerObservation{"work", "note.md"})
	if err != nil || out.Phase != "completed" {
		t.Fatalf("%#v %v", out, err)
	}
	f.store.record = &state.State{}
	_, err = observer.Observe(context.Background(), OwnerObservation{"work", "note.md"})
	requireCode(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	if f.native.calls != 0 || f.store.saves != 0 || f.store.admissions != 1 {
		t.Fatal("observation admitted/executed/tombstoned")
	}
}
func TestOwnerMutationPendingCannotDuplicateOrObservePrematurely(t *testing.T) {
	f := newOwnerFixture(t)
	f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
		_, err := f.service.Execute(ctx, f.request)
		requireCode(t, err, "COMPUTER_MUTATION_IN_PROGRESS")
		_, err = f.service.Observe(ctx, OwnerObservation{"work", "note.md"})
		requireCode(t, err, "COMPUTER_MUTATION_IN_PROGRESS")
		if err = r.BeforePublish(ctx); err != nil {
			return nil, err
		}
		return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
	}
	out, err := f.service.Execute(context.Background(), f.request)
	if err != nil || out.Phase != "completed" || f.native.calls != 1 || f.store.admissions != 1 || f.store.saves != 1 {
		t.Fatalf("%#v %v", out, err)
	}
}

func TestOwnerMutationEditPreimageAndUncertaintyStayBound(t *testing.T) {
	for _, mode := range []string{"exact", "wrong preimage", "wrong path", "unknown", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			f := newOwnerFixture(t)
			hash := strings.Repeat("b", 64)
			f.request.Operation = Edit{RelativePath: "note.md", Edits: []TextEdit{{OldText: "old", NewText: "new"}}, ExpectedSHA256: hash}
			f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
				if err := r.BeforePublish(ctx); err != nil {
					return nil, err
				}
				op, ok := r.Operation.(state.Edit)
				if !ok || op.ExpectedSHA256 != hash || len(op.Edits) != 1 || op.Edits[0].OldText != "old" {
					t.Fatal("edit correlation lost")
				}
				switch mode {
				case "unknown":
					return nil, errors.New("lost receipt")
				case "conflict":
					return nil, authority.Fail("WORKSPACE_MUTATION_CONFLICT", "native-workspace")
				}
				before := hash
				path := "note.md"
				if mode == "wrong preimage" {
					before = strings.Repeat("d", 64)
				}
				if mode == "wrong path" {
					path = "other.md"
				}
				return &port.MutationReceipt{Operation: "edit", RelativePath: path, Bytes: 3, Replacements: 1, BeforeSHA256: &before, AfterSHA256: strings.Repeat("c", 64)}, nil
			}
			for i := 0; i < 2; i++ {
				out, err := f.service.Execute(context.Background(), f.request)
				want := "outcome_unknown"
				if mode == "exact" {
					want = "completed"
				}
				if mode == "conflict" {
					want = "failed"
				}
				if err != nil || out.Phase != want {
					t.Fatalf("%#v %v", out, err)
				}
			}
			if f.native.calls != 1 || f.store.admissions != 1 || f.store.saves != 1 {
				t.Fatal("edit repeated")
			}
		})
	}
}

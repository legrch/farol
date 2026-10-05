package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// All effects below use the existing injected execution fixture. No disk,
// process, provider, live policy or connector route is qualified by these tests.
type connectorFixture struct {
	executionFixture
	connector *ConnectorService
	selection ConnectorSelection
	request   ConnectorRequest
}

func newConnectorFixture(t *testing.T) connectorFixture {
	t.Helper()
	f := newExecutionFixture(t)
	selection := ConnectorSelection{
		ConnectorOwner:     ConnectorOwner{OperationID: "op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"},
		ComputerGeneration: 7,
		Origin: state.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2,
			SessionID: f.request.SessionID, TaskID: f.request.TaskID, TaskEpoch: f.request.TaskEpoch, ParticipantID: f.request.ParticipantID,
			TurnID: f.request.TurnID, CallID: f.request.CallID, Generation: f.request.Generation, Operation: state.WriteKind},
	}
	connector, err := NewForConnectorExecution(selection, f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	return connectorFixture{f, connector, selection, ConnectorRequest{WorkspaceID: f.request.WorkspaceID, Operation: f.request.Operation}}
}

// The new trusted current-read port needs a value-only stub. Its guard uses
// the fixture's inside flag to catch journal/native calls inside callbacks.
type connectorCurrentGuard struct {
	t     *testing.T
	lease *testLease
	owner ConnectorOwner
	calls int
	hook  func(int, func() error) error
}

func (g *connectorCurrentGuard) WithMutationObservation(_ context.Context, id state.Identity, workspace, path string, inspect func() error) error {
	g.t.Helper()
	if id != g.owner.identity() || workspace != "work" || path != "note.md" {
		g.t.Fatalf("current read guard received wrong identity/target: %#v %q %q", id, workspace, path)
	}
	g.calls++
	g.lease.inside = true
	defer func() { g.lease.inside = false }()
	if g.hook != nil {
		return g.hook(g.calls, inspect)
	}
	return inspect()
}

func (f connectorFixture) current(t *testing.T) *connectorCurrentGuard {
	return &connectorCurrentGuard{t: t, lease: f.lease, owner: f.selection.ConnectorOwner}
}

func connectorPreparedRecord(t *testing.T, f connectorFixture) *state.State {
	t.Helper()
	b := state.Binding{Identity: f.selection.identity(), ComputerGeneration: f.selection.ComputerGeneration,
		WorkspaceID: "work", RelativePath: "note.md", Connector: f.selection.Origin, RequestDigest: strings.Repeat("a", 64)}
	s, err := state.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func connectorCompletedRecord(t *testing.T, f connectorFixture) *state.State {
	t.Helper()
	s, err := connectorPreparedRecord(t, f).Complete(state.Receipt{Operation: state.WriteKind, RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestConnectorMutationAtMostOnceAndOriginalOrigin(t *testing.T) {
	f := newConnectorFixture(t)
	for i := 0; i < 2; i++ {
		out, err := f.connector.Execute(context.Background(), f.request)
		if err != nil || out == nil || out.Phase != "completed" || out.Publication != "durable" || out.Origin != f.selection.Origin || out.ComputerGeneration != 7 || out.RelativePath != "note.md" || out.WorkspaceID != "work" || out.OperationID != "op" || out.Receipt == nil || out.Receipt.AfterSHA256 != strings.Repeat("c", 64) {
			t.Fatalf("original result lost: %#v %v", out, err)
		}
		out.Origin.CallID = "changed"
		out.Receipt.AfterSHA256 = "changed"
	}
	b := f.store.record.Binding()
	if b.Identity != f.selection.identity() || b.Connector != f.selection.Origin || f.connector.engine.terminal.Binding() != b || f.store.admissions != 1 || f.store.saves != 1 || f.native.calls != 1 {
		t.Fatal("replayed effect or changed stored origin")
	}
	f.request.Operation = Write{RelativePath: "note.md", Content: "different"}
	out, err := f.connector.Execute(context.Background(), f.request)
	if out != nil {
		t.Fatal("changed payload disclosed")
	}
	requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
	if f.store.admissions != 1 || f.store.saves != 1 || f.native.calls != 1 {
		t.Fatal("changed payload repeated an effect")
	}
}

func TestConnectorMutationFullUint64ConnectorGenerationPreserved(t *testing.T) {
	for name, generation := range map[string]uint64{"above-js-safe-integer": 9007199254740993, "max-uint64": ^uint64(0)} {
		t.Run(name, func(t *testing.T) {
			f := newConnectorFixture(t)
			s := f.selection
			s.Origin.ConnectorGeneration = generation
			service, err := NewForConnectorExecution(s, f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal("valid uint64 connector generation rejected", err)
			}
			for i := 0; i < 2; i++ {
				out, err := service.Execute(context.Background(), f.request)
				if err != nil || out == nil || out.Phase != "completed" || out.Origin != s.Origin || out.Origin.ConnectorGeneration != generation {
					t.Fatalf("connector generation narrowed: %#v %v", out, err)
				}
			}
			f.clock.now = f.lease.deadline
			observer, err := service.Observer(f.current(t))
			if err != nil {
				t.Fatal(err)
			}
			out, err := observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if err != nil || out == nil || out.Origin != s.Origin || out.Origin.ConnectorGeneration != generation || f.store.record.Binding().Connector != s.Origin {
				t.Fatalf("observer narrowed original connector generation: %#v %v", out, err)
			}
			if f.store.admissions != 1 || f.store.saves != 1 || f.store.loads != 0 || f.native.calls != 1 {
				t.Fatal("large generation replayed or observed with effects")
			}
		})
	}
}

func TestConnectorMutationConstructorMismatch(t *testing.T) {
	for name, change := range map[string]func(*ConnectorSelection){
		"owner":       func(s *ConnectorSelection) { s.OwnerID = "other" },
		"session":     func(s *ConnectorSelection) { s.Origin.SessionID = "other" },
		"task":        func(s *ConnectorSelection) { s.Origin.TaskID = "other" },
		"epoch":       func(s *ConnectorSelection) { s.Origin.TaskEpoch++ },
		"participant": func(s *ConnectorSelection) { s.Origin.ParticipantID = "other" },
		"turn":        func(s *ConnectorSelection) { s.Origin.TurnID = "other" },
	} {
		t.Run(name, func(t *testing.T) {
			f := newConnectorFixture(t)
			s := f.selection
			change(&s)
			out, err := NewForConnectorExecution(s, f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
			if out != nil {
				t.Fatal("mismatched constructor returned a service")
			}
			requireCode(t, err, "AUTHORITY_TASK_MISMATCH")
			if f.lease.calls != 0 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
				t.Fatal("constructor had effects")
			}
		})
	}
	f := newConnectorFixture(t)
	if out, err := NewForConnectorExecution(f.selection, nil, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock); out != nil || err == nil {
		t.Fatal("missing lease accepted")
	}
	if out, err := NewConnectorObserver(f.selection.ConnectorOwner, f.store, nil); out != nil || err == nil {
		t.Fatal("missing trusted current read guard accepted")
	}
	if out, err := f.connector.Observer(nil); out != nil || err == nil {
		t.Fatal("retained observer accepted missing guard")
	}
}

func TestConnectorMutationComputerGuardsBeforeAdmissionPublicationDisclosure(t *testing.T) {
	for name, change := range map[string]func(*testLease){
		"grant-generation":    func(l *testLease) { l.p.Grant.ComputerGeneration++ },
		"approval-generation": func(l *testLease) { l.a.Generation++ },
		"both-generations":    func(l *testLease) { l.p.Grant.ComputerGeneration++; l.a.Generation++ },
		"both-computers":      func(l *testLease) { l.p.Grant.ComputerID = "other"; l.a.ComputerID = "other" },
	} {
		for _, stage := range []string{"before-admission", "after-admission", "publication", "disclosure"} {
			t.Run(name+"/"+stage, func(t *testing.T) {
				f := newConnectorFixture(t)
				switch stage {
				case "before-admission":
					change(f.lease)
				case "after-admission":
					f.store.admitHook = func() { change(f.lease) }
				default:
					f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
						if stage == "publication" {
							change(f.lease)
						}
						if err := r.BeforePublish(ctx); err != nil {
							return nil, err
						}
						if stage == "disclosure" {
							change(f.lease)
						}
						return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
					}
				}
				out, err := f.connector.Execute(context.Background(), f.request)
				if out != nil {
					t.Fatal("revoked computer result disclosed")
				}
				requireCode(t, err, "AUTHORITY_COMPUTER_MISMATCH")
				if stage == "before-admission" {
					if f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
						t.Fatal("revoked computer admitted")
					}
				} else {
					want := state.Failed
					if stage == "disclosure" {
						want = state.Completed
					}
					if f.store.admissions != 1 || f.store.saves != 1 || f.store.record.Phase() != want {
						t.Fatal("guard lost settled outcome")
					}
					if stage == "after-admission" && f.native.calls != 0 {
						t.Fatal("revocation missed before dispatch")
					}
					if stage != "after-admission" && f.native.calls != 1 {
						t.Fatal("wrong dispatch count")
					}
				}
				calls := f.native.calls
				_, _ = f.connector.Execute(context.Background(), f.request)
				if f.native.calls != calls {
					t.Fatal("replayed after revocation")
				}
			})
		}
	}
}

func TestConnectorMutationChangedOriginStableIdentityRefuses(t *testing.T) {
	for name, change := range map[string]func(*ConnectorSelection, *testLease){
		"runtime":              func(s *ConnectorSelection, _ *testLease) { s.Origin.RuntimeID = "reconnected" },
		"connector-generation": func(s *ConnectorSelection, _ *testLease) { s.Origin.ConnectorGeneration++ },
		"call":                 func(s *ConnectorSelection, _ *testLease) { s.Origin.CallID = "later-call" },
		"turn": func(s *ConnectorSelection, l *testLease) {
			s.Origin.TurnID = "later-turn"
			l.binding.TurnID = "later-turn"
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newConnectorFixture(t)
			if _, err := f.connector.Execute(context.Background(), f.request); err != nil {
				t.Fatal(err)
			}
			s := f.selection
			change(&s, f.lease)
			if s.identity() != f.selection.identity() {
				t.Fatal("origin changed stable identity")
			}
			other, err := NewForConnectorExecution(s, f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			out, err := other.Execute(context.Background(), f.request)
			if out != nil {
				t.Fatal("changed origin accepted")
			}
			requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
			if f.native.calls != 1 || f.store.saves != 1 || f.store.admissions != 2 || f.store.record.Binding().Connector != f.selection.Origin {
				t.Fatal("changed origin dispatched or replaced result")
			}
		})
	}
}

func TestConnectorMutationExecutionCallbackMustSettleOnce(t *testing.T) {
	for _, mode := range []string{"zero", "twice", "ignored rejection", "late error"} {
		t.Run(mode, func(t *testing.T) {
			f := newConnectorFixture(t)
			service, err := NewForConnectorExecution(f.selection, callbackLease{testLease: f.lease, mode: mode}, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			out, err := service.Execute(context.Background(), f.request)
			if out != nil || err == nil || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
				t.Fatalf("unsettled callback admitted: %#v %v", out, err)
			}
		})
	}
}

type connectorRejectedSnapshotLease struct {
	*testLease
	validSecond bool
}

func (l connectorRejectedSnapshotLease) WithSnapshot(_ context.Context, _ string, inspect func(port.AccessSnapshot) error) error {
	l.calls++
	l.inside = true
	defer func() { l.inside = false }()
	p, a := l.p.Clone(), l.a.Clone()
	invalidApproval := a.Clone()
	invalidApproval.Generation++
	_ = inspect(port.AccessSnapshot{Participant: &p, Approval: &invalidApproval})
	if l.validSecond {
		_ = inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
	}
	return nil // Deliberately swallow every callback error.
}

func TestConnectorMutationRejectedSnapshotCannotHideBehindValidSecond(t *testing.T) {
	for _, validSecond := range []bool{false, true} {
		t.Run(map[bool]string{false: "swallowed-invalid-single", true: "rejected-first-valid-second"}[validSecond], func(t *testing.T) {
			f := newConnectorFixture(t)
			lease := connectorRejectedSnapshotLease{testLease: f.lease, validSecond: validSecond}
			service, err := NewForConnectorExecution(f.selection, lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			out, err := service.Execute(context.Background(), f.request)
			if out != nil {
				t.Fatal("rejected snapshot disclosed result")
			}
			want := "AUTHORITY_COMPUTER_MISMATCH"
			if validSecond {
				want = "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
			}
			requireCode(t, err, want)
			if f.lease.calls != 1 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
				t.Fatal("rejected wrapper callback admitted an effect")
			}
		})
	}
}

func TestConnectorObservationAfterLeaseExpiryPreservesOriginalOrigin(t *testing.T) {
	for _, retained := range []bool{false, true} {
		t.Run(map[bool]string{false: "cold", true: "retained"}[retained], func(t *testing.T) {
			f := newConnectorFixture(t)
			if _, err := f.connector.Execute(context.Background(), f.request); err != nil {
				t.Fatal(err)
			}
			f.clock.now = f.lease.deadline
			out, err := f.connector.Execute(context.Background(), f.request)
			if out != nil {
				t.Fatal("expired write lease disclosed")
			}
			requireCode(t, err, "AUTHORITY_EXPIRED")
			guard := f.current(t)
			var observer *ConnectorObserver
			if retained {
				observer, err = f.connector.Observer(guard)
			} else {
				observer, err = NewConnectorObserver(f.selection.ConnectorOwner, f.store, guard)
			}
			if err != nil {
				t.Fatal(err)
			}
			leaseCalls := f.lease.calls
			for i := 0; i < 2; i++ {
				out, err = observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
				if err != nil || out == nil || out.Origin != f.selection.Origin || out.Phase != "completed" || out.Publication != "durable" || out.Receipt == nil || out.Receipt.AfterSHA256 != strings.Repeat("c", 64) {
					t.Fatalf("metadata lost original origin/result: %#v %v", out, err)
				}
				out.Origin.CallID = "observer-call"
				out.Receipt.AfterSHA256 = "changed"
			}
			wantLoads := 2
			if retained {
				wantLoads = 0
			}
			if guard.calls != 4 || f.lease.calls != leaseCalls || f.store.loads != wantLoads || f.store.admissions != 1 || f.store.saves != 1 || f.native.calls != 1 {
				t.Fatal("metadata observer renewed lease or caused effects")
			}
		})
	}
}

func TestConnectorObservationPreflightAndFinalAuthorityRevocation(t *testing.T) {
	for _, stage := range []int{1, 2} {
		t.Run(map[int]string{1: "preflight", 2: "final"}[stage], func(t *testing.T) {
			f := newConnectorFixture(t)
			f.store.record = connectorCompletedRecord(t, f)
			guard := f.current(t)
			guard.hook = func(call int, inspect func() error) error {
				if call == stage {
					return authority.Fail("AUTHORITY_PATH_DENIED", "computer-policy")
				}
				return inspect()
			}
			observer, err := NewConnectorObserver(f.selection.ConnectorOwner, f.store, guard)
			if err != nil {
				t.Fatal(err)
			}
			out, err := observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if out != nil {
				t.Fatal("revoked read disclosed metadata")
			}
			requireCode(t, err, "AUTHORITY_PATH_DENIED")
			if guard.calls != stage || f.store.loads != stage-1 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 || f.lease.calls != 0 {
				t.Fatal("revoked read did IO/effects at wrong stage")
			}
		})
	}
}

func TestConnectorObservationCallbackMustSettleOnce(t *testing.T) {
	for _, stage := range []int{1, 2} {
		for _, mode := range []string{"zero", "double", "swallowed", "late-error"} {
			t.Run(map[int]string{1: "preflight", 2: "final"}[stage]+"/"+mode, func(t *testing.T) {
				f := newConnectorFixture(t)
				f.store.record = connectorCompletedRecord(t, f)
				guard := f.current(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				guard.hook = func(call int, inspect func() error) error {
					if call != stage {
						return inspect()
					}
					switch mode {
					case "zero":
						return nil
					case "double":
						_ = inspect()
						_ = inspect()
						return nil
					case "swallowed":
						cancel()
						_ = inspect()
						return nil
					case "late-error":
						_ = inspect()
						return errors.New("unsettled current read guard")
					}
					return nil
				}
				observer, err := NewConnectorObserver(f.selection.ConnectorOwner, f.store, guard)
				if err != nil {
					t.Fatal(err)
				}
				out, err := observer.Observe(ctx, ConnectorObservation{"work", "note.md"})
				if out != nil {
					t.Fatal("unsettled guard disclosed metadata")
				}
				want := "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
				if mode == "swallowed" {
					want = "WORKSPACE_MUTATION_CANCELLED"
				}
				requireCode(t, err, want)
				if guard.calls != stage || f.store.loads != stage-1 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
					t.Fatal("invalid current callback had effects")
				}
			})
		}
	}
	// Swallow the final inspect's classified rejection without cancellation.
	f := newConnectorFixture(t)
	guard := f.current(t)
	guard.hook = func(_ int, inspect func() error) error { _ = inspect(); return nil }
	observer, err := NewConnectorObserver(f.selection.ConnectorOwner, f.store, guard)
	if err != nil {
		t.Fatal(err)
	}
	out, err := observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
	if out != nil {
		t.Fatal("swallowed missing-record rejection disclosed")
	}
	requireCode(t, err, "COMPUTER_MUTATION_OPERATION_NOT_FOUND")
	if guard.calls != 2 || f.store.loads != 1 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
		t.Fatal("swallowed inspect error caused effects")
	}
}

func TestConnectorObservationRetainedFencesBeatDisk(t *testing.T) {
	for _, mode := range []string{"pending", "lost-admit", "memory-only"} {
		t.Run(mode, func(t *testing.T) {
			f := newConnectorFixture(t)
			guard := f.current(t)
			observer, err := f.connector.Observer(guard)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "pending":
				f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
					f.store.record = connectorCompletedRecord(t, f)
					out, err := observer.Observe(ctx, ConnectorObservation{"work", "note.md"})
					if out != nil {
						t.Fatal("pending result disclosed disk completion")
					}
					requireCode(t, err, "COMPUTER_MUTATION_IN_PROGRESS")
					if f.store.loads != 0 || f.store.saves != 0 {
						t.Fatal("pending observer loaded/saved disk")
					}
					if err := r.BeforePublish(ctx); err != nil {
						return nil, err
					}
					return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
				}
			case "lost-admit":
				f.store.admitErr = errors.New("lost admission ACK")
			case "memory-only":
				f.store.saveErr = errors.New("lost terminal ACK")
			}
			out, err := f.connector.Execute(context.Background(), f.request)
			if mode == "lost-admit" {
				requireCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			} else if err != nil || out == nil {
				t.Fatal("fixture execution failed", err)
			}
			if mode == "pending" {
				return
			}
			f.store.record = connectorCompletedRecord(t, f)
			f.clock.now = f.lease.deadline
			for i := 0; i < 2; i++ {
				out, err = observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
				if mode == "lost-admit" {
					if out != nil {
						t.Fatal("lost-admit fence upgraded from disk")
					}
					requireCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
				} else if err != nil || out == nil || out.Publication != "memory_only" || out.Phase != "completed" || out.Origin != f.selection.Origin {
					t.Fatalf("memory-only upgraded from disk: %#v %v", out, err)
				}
			}
			wantEffects := 1
			if mode == "lost-admit" {
				wantEffects = 0
			}
			if f.store.loads != 0 || f.store.admissions != 1 || f.store.saves != wantEffects || f.native.calls != wantEffects {
				t.Fatal("retained fence observation caused effects")
			}
		})
	}
}

func TestConnectorObservationFinalFenceWinsAfterDiskLoad(t *testing.T) {
	for _, mode := range []string{"pending", "lost-admit", "memory-only"} {
		t.Run(mode, func(t *testing.T) {
			f := newConnectorFixture(t)
			f.store.record = connectorCompletedRecord(t, f)
			guard := f.current(t)
			// Inject a concurrent engine state change after Load, before disclosure.
			// This qualifies policy ordering, not actual runtime concurrency.
			guard.hook = func(call int, inspect func() error) error {
				if call == 2 {
					e := f.connector.engine
					e.gate.Lock()
					switch mode {
					case "pending":
						e.pending = true
					case "lost-admit":
						e.blocked = unknown("operation-store")
					case "memory-only":
						e.terminal = connectorCompletedRecord(t, f)
						e.publication = "memory_only"
					}
					e.gate.Unlock()
				}
				return inspect()
			}
			observer, err := f.connector.Observer(guard)
			if err != nil {
				t.Fatal(err)
			}
			out, err := observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if mode == "memory-only" {
				if err != nil || out == nil || out.Publication != "memory_only" || out.Origin != f.selection.Origin {
					t.Fatalf("final cache lost to loaded disk: %#v %v", out, err)
				}
			} else {
				if out != nil {
					t.Fatal("final fence disclosed loaded disk")
				}
				want := "COMPUTER_MUTATION_IN_PROGRESS"
				if mode == "lost-admit" {
					want = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
				}
				requireCode(t, err, want)
			}
			if guard.calls != 2 || f.store.loads != 1 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
				t.Fatal("final fence observation had effects")
			}
		})
	}
}

func TestConnectorObservationPreparedMissingCorruptAndCrossedRecords(t *testing.T) {
	for _, mode := range []string{"prepared", "missing", "corrupt", "owner", "profile", "computer", "operation", "workspace", "path"} {
		t.Run(mode, func(t *testing.T) {
			f := newConnectorFixture(t)
			prepared := connectorPreparedRecord(t, f)
			f.store.record = prepared
			want := "COMPUTER_MUTATION_OPERATION_CONFLICT"
			switch mode {
			case "prepared":
				want = ""
			case "missing":
				f.store.record = nil
				want = "COMPUTER_MUTATION_OPERATION_NOT_FOUND"
			case "corrupt":
				f.store.record = &state.State{}
				want = "COMPUTER_MUTATION_STORE_UNAVAILABLE"
			default:
				b := prepared.Binding()
				switch mode {
				case "owner":
					b.Identity.OwnerID = "other"
				case "profile":
					b.Identity.ProfileID = "other"
				case "computer":
					b.Identity.ComputerID = "other"
				case "operation":
					b.Identity.OperationID = "other"
				case "workspace":
					b.WorkspaceID = "other"
				case "path":
					b.RelativePath = "other.md"
				}
				var err error
				f.store.record, err = state.NewPrepared(b)
				if err != nil {
					t.Fatal(err)
				}
			}
			guard := f.current(t)
			observer, err := NewConnectorObserver(f.selection.ConnectorOwner, f.store, guard)
			if err != nil {
				t.Fatal(err)
			}
			out, err := observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if want == "" {
				if err != nil || out == nil || out.Phase != "outcome_unknown" || out.Publication != "durable" || out.Receipt != nil || out.Failure == nil || out.Failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || out.Origin != f.selection.Origin || f.store.record.Phase() != state.Prepared {
					t.Fatalf("prepared became execution permission/tombstone: %#v %v", out, err)
				}
			} else {
				if out != nil {
					t.Fatal("invalid record disclosed")
				}
				requireCode(t, err, want)
			}
			if guard.calls != 2 || f.store.loads != 1 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
				t.Fatal("cold observation changed record or executed")
			}
		})
	}
	f := newConnectorFixture(t)
	guard := f.current(t)
	observer, err := f.connector.Observer(guard)
	if err != nil {
		t.Fatal(err)
	}
	out, err := observer.Observe(context.Background(), ConnectorObservation{"work", "../escape"})
	if out != nil {
		t.Fatal("invalid path disclosed")
	}
	requireCode(t, err, "COMPUTER_INVALID_REQUEST")
	if guard.calls != 0 || f.store.loads != 0 || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
		t.Fatal("invalid path reached guard or journal")
	}
}

func TestConnectorObservationPreparedPeerLaterCompletionRequiresOriginalBinding(t *testing.T) {
	for _, mode := range []string{"exact", "origin-runtime", "origin-call", "digest", "computer-generation"} {
		t.Run(mode, func(t *testing.T) {
			f := newConnectorFixture(t)
			prepared := connectorPreparedRecord(t, f)
			f.store.record = prepared
			out, err := f.connector.Execute(context.Background(), f.request)
			if err != nil || out == nil || out.Phase != "outcome_unknown" || f.connector.engine.terminal.Phase() != state.Prepared {
				t.Fatalf("prepared peer not retained read-only: %#v %v", out, err)
			}
			f.clock.now = f.lease.deadline
			guard := f.current(t)
			observer, err := f.connector.Observer(guard)
			if err != nil {
				t.Fatal(err)
			}
			out, err = observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if err != nil || out == nil || out.Phase != "outcome_unknown" || f.store.record.Phase() != state.Prepared {
				t.Fatal("prepared observer changed peer", err)
			}
			b := prepared.Binding()
			switch mode {
			case "origin-runtime":
				b.Connector.RuntimeID = "other-runtime"
			case "origin-call":
				b.Connector.CallID = "other-call"
			case "digest":
				b.RequestDigest = strings.Repeat("b", 64)
			case "computer-generation":
				b.ComputerGeneration++
			}
			changed, err := state.NewPrepared(b)
			if err != nil {
				t.Fatal(err)
			}
			terminal, err := changed.Complete(state.Receipt{Operation: state.WriteKind, RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)})
			if err != nil {
				t.Fatal(err)
			}
			// Simulate a peer's later disk completion, never this observer's Save.
			f.store.record = terminal
			out, err = observer.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if mode == "exact" {
				if err != nil || out == nil || out.Phase != "completed" || out.Publication != "durable" || out.Origin != f.selection.Origin {
					t.Fatalf("exact peer completion lost: %#v %v", out, err)
				}
			} else {
				if out != nil {
					t.Fatal("crossed binding upgraded unknown to completion")
				}
				requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
			}
			if guard.calls != 4 || f.store.loads != 2 || f.store.admissions != 1 || f.store.saves != 0 || f.native.calls != 0 || *f.connector.engine.binding != prepared.Binding() {
				t.Fatal("prepared observation rebound, published or executed")
			}
		})
	}
}

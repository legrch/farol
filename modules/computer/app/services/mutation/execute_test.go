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

// Entirely injected policy, clock, journal and native observations. These tests
// do not qualify real Task/Chat, disk durability, native syscalls or live routing.
type testClock struct{ now time.Time }

func (c *testClock) Now() time.Time { return c.now }

type testLease struct {
	binding  port.TaskBinding
	deadline time.Time
	p        authority.Participant
	a        authority.Approval
	calls    int
	hook     func(int)
	inside   bool
}

func (l *testLease) Binding() port.TaskBinding { return l.binding }
func (l *testLease) Deadline() time.Time       { return l.deadline }
func (l *testLease) WithSnapshot(_ context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	l.calls++
	if l.hook != nil {
		l.hook(l.calls)
	}
	if id != l.binding.ParticipantID {
		return errors.New("wrong participant")
	}
	l.inside = true
	defer func() { l.inside = false }()
	p, a := l.p.Clone(), l.a.Clone()
	return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
}

type testDigest struct{}

func (testDigest) Digest(in port.MutationDigestInput) (string, error) {
	v := in.Operation.(state.Write)
	if v.Content == "different" {
		return strings.Repeat("b", 64), nil
	}
	return strings.Repeat("a", 64), nil
}

type testStore struct {
	record                   *state.State
	admissions, saves, loads int
	admitHook                func()
	admitErr, saveErr        error
	lease                    *testLease
}

func (j *testStore) Admit(_ context.Context, record *state.State) (port.MutationAdmission, error) {
	if j.lease.inside {
		panic("journal inside owner gate")
	}
	j.admissions++
	if j.admitHook != nil {
		j.admitHook()
	}
	if j.admitErr != nil {
		return port.MutationAdmission{}, j.admitErr
	}
	if j.record != nil {
		copy := j.record.Clone()
		return port.MutationAdmission{Status: port.MutationExisting, Record: &copy}, nil
	}
	copy := record.Clone()
	j.record = &copy
	out := copy.Clone()
	return port.MutationAdmission{Status: port.MutationAdmitted, Record: &out}, nil
}
func (j *testStore) Load(_ context.Context, _ state.Identity) (*state.State, error) {
	if j.lease.inside {
		panic("load inside gate")
	}
	j.loads++
	if j.record == nil {
		return nil, nil
	}
	copy := j.record.Clone()
	return &copy, nil
}
func (j *testStore) Save(_ context.Context, r *state.State) error {
	if j.lease.inside {
		panic("save inside gate")
	}
	j.saves++
	if j.saveErr != nil {
		return j.saveErr
	}
	copy := r.Clone()
	j.record = &copy
	return nil
}

type testNative struct {
	lease *testLease
	calls int
	run   func(context.Context, port.MutationRequest) (*port.MutationReceipt, error)
}

func (n *testNative) Mutate(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
	if n.lease.inside {
		panic("native inside owner gate")
	}
	n.calls++
	if n.run != nil {
		return n.run(ctx, r)
	}
	if err := r.BeforePublish(ctx); err != nil {
		return nil, err
	}
	return &port.MutationReceipt{Operation: "write", RelativePath: r.Operation.Path(), Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
}

type executionFixture struct {
	service *Service
	lease   *testLease
	store   *testStore
	native  *testNative
	clock   *testClock
	request CheckRequest
}

func newExecutionFixture(t *testing.T) executionFixture {
	t.Helper()
	now := time.Unix(1700000000, 0)
	clock := &testClock{now: now}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"}
	policy := authority.Policy{ExpiresAt: now.Add(15 * time.Second), Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: []authority.Capability{authority.Write}, Network: authority.NoNetwork, Commands: authority.NoCommands}
	lease := &testLease{binding: binding, deadline: now.Add(15 * time.Second), p: authority.Participant{ParticipantID: binding.ParticipantID, Role: authority.Main, MutationOwnership: authority.TaskOwnership, Grant: authority.Grant{Identity: binding.Identity, AuthorityID: "grant", ComputerID: "computer", ComputerGeneration: 7, Policy: policy}}, a: authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7, ExpiresAt: now.Add(time.Hour), Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "7", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Write}}}
	store := &testStore{lease: lease}
	native := &testNative{lease: lease}
	s, err := NewForExecution("op", lease, store, native, testDigest{}, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	request := CheckRequest{OperationID: "op", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", Generation: 90, CallID: "call", WorkspaceID: "work", Operation: Write{RelativePath: "note.md", Content: "new"}}
	return executionFixture{s, lease, store, native, clock, request}
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v; want %s", err, code)
	}
}
func TestMutationExecutionExactlyOnceAndOwnedValues(t *testing.T) {
	f := newExecutionFixture(t)
	out, err := f.service.Execute(context.Background(), f.request)
	if err != nil || out.Phase != "completed" || out.Publication != "durable" || f.native.calls != 1 || f.store.saves != 1 || f.store.admissions != 1 {
		t.Fatalf("%#v %v", out, err)
	}
	out.Receipt.AfterSHA256 = "corrupt"
	f.request.CallID = "next-call"
	f.request.Generation = 91
	second, err := f.service.Execute(context.Background(), f.request)
	if err != nil || second.CallID != "next-call" || second.Generation != 91 || second.Receipt.AfterSHA256 != strings.Repeat("c", 64) || f.native.calls != 1 || f.store.saves != 1 {
		t.Fatalf("%#v %v", second, err)
	}
	f.request.Operation = Write{RelativePath: "note.md", Content: "different"}
	_, err = f.service.Execute(context.Background(), f.request)
	requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
}
func TestMutationExecutionAdmissionDelayExpiryAndGenerationWin(t *testing.T) {
	for _, name := range []string{"expiry", "generation", "scope", "exclusion"} {
		t.Run(name, func(t *testing.T) {
			f := newExecutionFixture(t)
			f.store.admitHook = func() {
				switch name {
				case "expiry":
					f.clock.now = f.lease.deadline
				case "generation":
					f.lease.a.Generation++
				case "scope":
					f.lease.p.Grant.Capabilities = nil
				case "exclusion":
					f.lease.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/note.md"}}
				}
			}
			out, err := f.service.Execute(context.Background(), f.request)
			if out != nil || err == nil || f.native.calls != 0 || f.store.saves != 1 || f.store.record.Phase() != state.Failed {
				t.Fatalf("revocation/expiry bypass: %#v %v", out, err)
			}
		})
	}
}
func TestMutationExecutionGuardBeforeEffectAndDisclosure(t *testing.T) {
	f := newExecutionFixture(t)
	f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
		f.lease.a.Generation++
		return nil, r.BeforePublish(ctx)
	}
	out, err := f.service.Execute(context.Background(), f.request)
	if out != nil || err == nil || f.native.calls != 1 || f.store.record.Phase() != state.Failed {
		t.Fatalf("guard bypass %#v %v", out, err)
	}
	f = newExecutionFixture(t)
	f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
		if err := r.BeforePublish(ctx); err != nil {
			return nil, err
		}
		f.lease.a.Generation++
		return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
	}
	out, err = f.service.Execute(context.Background(), f.request)
	if out != nil || err == nil || f.store.record.Phase() != state.Completed || f.native.calls != 1 {
		t.Fatalf("lost known completion %#v %v", out, err)
	}
	_, err = f.service.Execute(context.Background(), f.request)
	if err == nil || f.native.calls != 1 {
		t.Fatal("redispatched after lost disclosure")
	}
}
func TestMutationExecutionUncertainAdmissionNeverDispatches(t *testing.T) {
	f := newExecutionFixture(t)
	f.store.admitErr = errors.New("lost admission acknowledgement")
	for i := 0; i < 2; i++ {
		_, err := f.service.Execute(context.Background(), f.request)
		requireCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	}
	if f.store.admissions != 1 || f.native.calls != 0 || f.store.saves != 0 {
		t.Fatal("retried admission/effect")
	}
}
func TestMutationExecutionMemoryOnlyAndRestartPrepared(t *testing.T) {
	f := newExecutionFixture(t)
	f.store.saveErr = errors.New("lost publication ACK")
	for i := 0; i < 2; i++ {
		out, err := f.service.Execute(context.Background(), f.request)
		if err != nil || out.Phase != "completed" || out.Publication != "memory_only" {
			t.Fatalf("%#v %v", out, err)
		}
	}
	if f.native.calls != 1 || f.store.saves != 1 || f.store.record.Phase() != state.Prepared {
		t.Fatal("retried terminal save/native")
	}
	restarted, err := NewForExecution("op", f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	out, err := restarted.Execute(context.Background(), f.request)
	if err != nil || out.Phase != "outcome_unknown" || f.native.calls != 1 || f.store.saves != 1 || f.store.record.Phase() != state.Prepared {
		t.Fatalf("replayed prepared or tombstoned peer %#v %v", out, err)
	}
}
func TestMutationExecutionUnknownMalformedReceiptAndRefusalNoReplay(t *testing.T) {
	for _, name := range []string{"unknown", "malformed", "refused", "hash"} {
		t.Run(name, func(t *testing.T) {
			f := newExecutionFixture(t)
			f.native.run = func(context.Context, port.MutationRequest) (*port.MutationReceipt, error) {
				switch name {
				case "unknown":
					return nil, errors.New("lost receipt")
				case "refused":
					return nil, authority.Fail("WORKSPACE_MUTATION_CONFLICT", "native-workspace")
				case "hash":
					hash := strings.Repeat("d", 64)
					return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", BeforeSHA256: &hash, AfterSHA256: hash}, nil
				default:
					return &port.MutationReceipt{Operation: "edit", RelativePath: "other.md", AfterSHA256: "invalid"}, nil
				}
			}
			for i := 0; i < 2; i++ {
				out, err := f.service.Execute(context.Background(), f.request)
				want := "outcome_unknown"
				if name == "refused" {
					want = "failed"
				}
				if err != nil || out.Phase != want {
					t.Fatalf("%#v %v", out, err)
				}
			}
			if f.native.calls != 1 || f.store.saves != 1 {
				t.Fatal("replayed")
			}
		})
	}
}
func TestMutationExecutionPendingAndCrossServicePrepared(t *testing.T) {
	f := newExecutionFixture(t)
	f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
		_, err := f.service.Execute(ctx, f.request)
		requireCode(t, err, "COMPUTER_MUTATION_IN_PROGRESS")
		other, err := NewForExecution("op", f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
		if err != nil {
			t.Fatal(err)
		}
		out, err := other.Execute(ctx, f.request)
		if err != nil || out.Phase != "outcome_unknown" || f.store.saves != 0 || f.store.record.Phase() != state.Prepared {
			t.Fatalf("peer tampered active prepared %#v %v", out, err)
		}
		return &port.MutationReceipt{Operation: "write", RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
	}
	out, err := f.service.Execute(context.Background(), f.request)
	if err != nil || out.Phase != "completed" || f.native.calls != 1 {
		t.Fatalf("%#v %v", out, err)
	}
}
func TestMutationExecutionBodyCannotSelectOwnerOrExtendDeadline(t *testing.T) {
	for _, change := range []func(*CheckRequest){func(r *CheckRequest) { r.OwnerID = "other" }, func(r *CheckRequest) { r.TurnID = "new" }, func(r *CheckRequest) { r.TaskEpoch++ }, func(r *CheckRequest) { r.ParticipantID = "other" }, func(r *CheckRequest) { r.OperationID = "other" }} {
		f := newExecutionFixture(t)
		change(&f.request)
		_, err := f.service.Execute(context.Background(), f.request)
		requireCode(t, err, "COMPUTER_INVALID_REQUEST")
		if f.native.calls != 0 || f.store.admissions != 0 {
			t.Fatal("body admitted")
		}
	}
	f := newExecutionFixture(t)
	f.lease.deadline = f.clock.now.Add(time.Hour)
	f.clock.now = f.service.deadline
	_, err := f.service.Execute(context.Background(), f.request)
	requireCode(t, err, "AUTHORITY_EXPIRED")
	if f.native.calls != 0 {
		t.Fatal("extended selected deadline")
	}
	_, err = NewForExecution("another", f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
	requireCode(t, err, "AUTHORITY_EXPIRED")
}

type callbackLease struct {
	*testLease
	mode string
}

func (l callbackLease) WithSnapshot(_ context.Context, _ string, inspect func(port.AccessSnapshot) error) error {
	p, a := l.p.Clone(), l.a.Clone()
	snapshot := port.AccessSnapshot{Participant: &p, Approval: &a}
	switch l.mode {
	case "zero":
		return nil
	case "twice":
		_ = inspect(snapshot)
		_ = inspect(snapshot)
		return nil
	case "ignored rejection":
		snapshot.Participant = nil
		_ = inspect(snapshot)
		return nil
	case "late error":
		_ = inspect(snapshot)
		return errors.New("owner unavailable after callback")
	}
	return inspect(snapshot)
}
func TestMutationExecutionOwnerCallbackMustBeExactlyOnceAndSettled(t *testing.T) {
	for _, mode := range []string{"zero", "twice", "ignored rejection", "late error"} {
		t.Run(mode, func(t *testing.T) {
			f := newExecutionFixture(t)
			f.service.lease = callbackLease{testLease: f.lease, mode: mode}
			out, err := f.service.Execute(context.Background(), f.request)
			if out != nil || err == nil || f.store.admissions != 0 || f.native.calls != 0 {
				t.Fatalf("invalid owner callback admitted %#v %v", out, err)
			}
		})
	}
}
func TestMutationExecutionCrossServiceDifferentPayloadConflicts(t *testing.T) {
	f := newExecutionFixture(t)
	_, err := f.service.Execute(context.Background(), f.request)
	if err != nil {
		t.Fatal(err)
	}
	other, err := NewForExecution("op", f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	f.request.Operation = Write{RelativePath: "note.md", Content: "different"}
	_, err = other.Execute(context.Background(), f.request)
	requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
	if f.native.calls != 1 || f.store.saves != 1 {
		t.Fatal("different payload redispatched")
	}
}

package process

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// No native invocation. Current owner, clock, preparation/reservation and child
// are in-memory doubles; provider/session/model strings are synthetic correlation.
type selectedDouble struct {
	*prepared
	invocation Invocation
}

func (p *selectedDouble) Invocation() Invocation { return p.invocation.Clone() }

type preparerDouble struct {
	scope    Scope
	selected *selectedDouble
	calls    int
	e        *execution
	before   func()
	err      error
	captured Invocation
}

func (p *preparerDouble) Scope() Scope { return p.scope }
func (p *preparerDouble) Prepare(_ context.Context, v Invocation) (Selected, error) {
	if p.e.inCallback {
		panic("preparation under owner gate")
	}
	p.calls++
	p.captured = v.Clone()
	if p.before != nil {
		p.before()
	}
	if p.err != nil {
		return nil, p.err
	}
	p.selected.invocation = v.Clone()
	return p.selected, nil
}
func prepareSetup(t *testing.T) (*Service, *preparerDouble, *clock, *execution, *reservation, PrepareRequest) {
	t.Helper()
	_, clock, e, reservation, p := setup(t)
	scope := Scope{RuntimeID: "cli", WorkspaceID: p.seal.WorkspaceID, Root: p.seal.Root, Cwd: p.seal.Cwd, RootIdentity: p.seal.RootIdentity, Write: p.seal.Write}
	builder := &preparerDouble{scope: scope, e: e, selected: &selectedDouble{prepared: p}}
	s, err := NewForInvocation("operation", e, builder, reservation, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	request := PrepareRequest{OperationID: "operation", Invocation: Invocation{RuntimeID: "cli", SessionID: "exact-session", ModelID: "selected-model", AdmissionID: "authority", Arguments: []string{"--session-id", "exact-session", "--model", "selected-model"}, Input: []byte("synthetic input")}}
	return s, builder, clock, e, reservation, request
}
func prepareCode(t *testing.T, err error, want string) {
	t.Helper()
	var local *Failure
	var native *authority.Failure
	if errors.As(err, &local) && local.Code == want || errors.As(err, &native) && native.Code == want {
		return
	}
	t.Fatalf("got %v; want %s", err, want)
}
func TestPrepareThenStartMapsExactInvocationWithoutDispatch(t *testing.T) {
	s, p, _, _, r, request := prepareSetup(t)
	out, err := s.Prepare(context.Background(), request)
	if err != nil || out.OperationID != "operation" || out.SessionID != "exact-session" || out.ModelID != "selected-model" || out.AdmissionID != "authority" || out.Digest != p.selected.seal.Digest || p.calls != 1 || p.selected.calls != 0 || r.calls != 0 || !sameInvocation(p.captured, request.Invocation) {
		t.Fatalf("%#v %v", out, err)
	}
	out.SessionID = "changed"
	out, err = s.Prepare(context.Background(), request)
	if err != nil || out.SessionID != "exact-session" || p.calls != 1 {
		t.Fatalf("reprepared %#v %v", out, err)
	}
	original := s.intent.Deadline
	start(t, s)
	start(t, s)
	if r.calls != 1 || p.selected.calls != 1 || !p.selected.deadline.Equal(original) {
		t.Fatal("start replayed/reset lease")
	}
}
func TestPrepareCannotChooseAnotherRuntimeAdmissionOrMutablePayload(t *testing.T) {
	for _, change := range []func(*PrepareRequest){func(r *PrepareRequest) { r.OperationID = "other" }, func(r *PrepareRequest) { r.Invocation.RuntimeID = "other" }, func(r *PrepareRequest) { r.Invocation.AdmissionID = "other" }, func(r *PrepareRequest) { r.Invocation.SessionID = "" }, func(r *PrepareRequest) { r.Invocation.Arguments = []string{"\x00"} }, func(r *PrepareRequest) { r.Invocation.Arguments = []string{string([]byte{255})} }, func(r *PrepareRequest) { r.Invocation.Input = make([]byte, MaximumInput+1) }, func(r *PrepareRequest) { r.Invocation.Arguments = make([]string, MaximumArguments+1) }, func(r *PrepareRequest) {
		r.Invocation.Arguments = []string{strings.Repeat("x", MaximumArgumentBytes+1)}
	}} {
		s, p, _, _, r, request := prepareSetup(t)
		change(&request)
		out, err := s.Prepare(context.Background(), request)
		if out != nil || err == nil || p.calls != 0 || r.calls != 0 || p.selected.calls != 0 {
			t.Fatalf("invalid selection prepared %#v %v", out, err)
		}
	}
	s, p, _, _, r, request := prepareSetup(t)
	_, err := s.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	request.Invocation.Arguments[0] = "different"
	request.Invocation.Input[0] = 'X'
	_, err = s.Prepare(context.Background(), request)
	prepareCode(t, err, "PROCESS_INVOCATION_CONFLICT")
	if p.captured.Arguments[0] != "--session-id" || p.captured.Input[0] != 's' || p.calls != 1 || r.calls != 0 {
		t.Fatal("mutable payload rebound")
	}
}
func TestPrepareExpiryRevokeGenerationAndAdmissionWin(t *testing.T) {
	for _, name := range []string{"expiry", "revoke", "generation", "admission", "shell", "write"} {
		t.Run(name, func(t *testing.T) {
			s, p, c, e, r, request := prepareSetup(t)
			p.before = func() {
				switch name {
				case "expiry":
					c.now = s.intent.Deadline
				case "revoke":
					e.revoked = true
				case "generation":
					e.a.Generation++
				case "admission":
					e.p.Grant.AuthorityID = "changed"
				case "shell":
					e.a.Workspaces[0].ShellVerified = false
				case "write":
					e.p.Grant.Capabilities = nil
				}
			}
			out, err := s.Prepare(context.Background(), request)
			if out != nil || err == nil || p.calls != 1 || p.selected.calls != 0 || r.calls != 0 {
				t.Fatalf("stale selection %#v %v", out, err)
			}
			_, err = s.Prepare(context.Background(), request)
			if err == nil || p.calls != 1 {
				t.Fatal("reprepared refusal")
			}
			_, err = s.Start(context.Background(), StartRequest{"operation"})
			if err == nil || p.selected.calls != 0 || r.calls != 0 {
				t.Fatal("refused prepare dispatched")
			}
		})
	}
}
func TestPrepareDriftBeforeStartIsUnknownAndNeverReserves(t *testing.T) {
	s, p, _, _, r, request := prepareSetup(t)
	_, err := s.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	p.selected.invocation.ModelID = "changed"
	for i := 0; i < 2; i++ {
		_, err = s.Start(context.Background(), StartRequest{"operation"})
		unknown(t, err)
	}
	if p.calls != 1 || p.selected.calls != 0 || r.calls != 0 {
		t.Fatal("drift dispatched")
	}
}
func TestPrepareChangedScopeAndUnknownRefusalNeverRetry(t *testing.T) {
	for _, name := range []string{"scope", "unknown", "refused"} {
		t.Run(name, func(t *testing.T) {
			s, p, _, _, r, request := prepareSetup(t)
			switch name {
			case "scope":
				p.selected.seal.Cwd = "/workspace/code/other"
			case "unknown":
				p.err = &NativeFailure{Unknown: true}
			case "refused":
				p.err = &NativeFailure{}
			}
			for i := 0; i < 2; i++ {
				out, err := s.Prepare(context.Background(), request)
				if out != nil || err == nil {
					t.Fatal("failed preparation accepted")
				}
			}
			if p.calls != 1 || r.calls != 0 || p.selected.calls != 0 {
				t.Fatal("retried preparation")
			}
		})
	}
}
func TestPreparePendingAndUnpreparedStartCannotDispatch(t *testing.T) {
	s, p, _, _, r, request := prepareSetup(t)
	_, err := s.Start(context.Background(), StartRequest{"operation"})
	prepareCode(t, err, "PROCESS_NOT_PREPARED")
	p.before = func() {
		_, err := s.Prepare(context.Background(), request)
		prepareCode(t, err, "PROCESS_PREPARATION_PENDING")
		_, err = s.Start(context.Background(), StartRequest{"operation"})
		prepareCode(t, err, "PROCESS_START_PENDING")
	}
	_, err = s.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if p.calls != 1 || r.calls != 0 || p.selected.calls != 0 {
		t.Fatal("nested dispatch")
	}
}
func TestPrepareConstructorPreservesDeadlineAndRejectsInflation(t *testing.T) {
	s, p, c, e, r, request := prepareSetup(t)
	original := s.intent.Deadline
	e.deadline = c.now.Add(time.Hour)
	_, err := s.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	start(t, s)
	if !p.selected.deadline.Equal(original) {
		t.Fatal("lease reminted")
	}
	_, err = NewForInvocation("next", e, p, r, &sync.Mutex{}, c)
	prepareCode(t, err, "AUTHORITY_EXPIRED")
}
func TestPrepareProcessBudgetSurvivesPreparationWithoutRenewal(t *testing.T) {
	_, p, c, e, r, request := prepareSetup(t)
	e.deadline = c.now.Add(authority.ProcessExecutionLifetime)
	e.p.Grant.ExpiresAt, e.a.ExpiresAt = e.deadline, e.deadline
	s, err := NewForInvocation("operation", e, p, r, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	original := e.deadline
	p.before = func() { c.now = c.now.Add(30 * time.Second) }
	if _, err = s.Prepare(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	start(t, s)
	if !p.selected.deadline.Equal(original) || !s.intent.Deadline.Equal(original) {
		t.Fatal("preparation reset process deadline")
	}
	e.deadline = c.now.Add(authority.ProcessExecutionLifetime + time.Millisecond)
	_, err = NewForInvocation("too-long", e, p, r, &sync.Mutex{}, c)
	prepareCode(t, err, "AUTHORITY_EXPIRED")
}

func TestPrepareCurrentAdmissionStillGatesStartAfterReady(t *testing.T) {
	s, p, _, e, r, request := prepareSetup(t)
	_, err := s.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	e.p.Grant.AuthorityID = "reissued-other-admission"
	_, err = s.Start(context.Background(), StartRequest{"operation"})
	prepareCode(t, err, "AUTHORITY_TASK_MISMATCH")
	if r.calls != 0 || p.selected.calls != 0 {
		t.Fatal("admission rebind launched")
	}
}

func TestPrepareLostDisclosureRetainsExactSelectionWithoutReprepare(t *testing.T) {
	s, p, _, e, r, request := prepareSetup(t)
	calls := 0
	e.after = func() {
		calls++
		if calls == 2 {
			e.revoked = true
		}
	}
	out, err := s.Prepare(context.Background(), request)
	if out != nil || err == nil || s.prepared == nil || p.calls != 1 || p.selected.calls != 0 || r.calls != 0 {
		t.Fatalf("lost preparation replay/cache %#v %v", out, err)
	}
	e.after = nil
	e.revoked = false
	out, err = s.Prepare(context.Background(), request)
	if err != nil || out.SessionID != "exact-session" || p.calls != 1 || p.selected.calls != 0 || r.calls != 0 {
		t.Fatalf("reconstructed selection %#v %v", out, err)
	}
}
func TestPrepareObserverDriftLatchesUnknownBeforeAnyStart(t *testing.T) {
	s, p, _, _, r, request := prepareSetup(t)
	_, err := s.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	original := p.selected.seal
	p.selected.seal.Digest = strings.Repeat("b", 64)
	_, err = s.Prepare(context.Background(), request)
	unknown(t, err)
	p.selected.seal = original
	_, err = s.Start(context.Background(), StartRequest{"operation"})
	unknown(t, err)
	if p.selected.calls != 0 || r.calls != 0 || p.calls != 1 {
		t.Fatal("unknown preparation became execution")
	}
}

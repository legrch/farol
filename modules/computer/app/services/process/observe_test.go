package process

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure coherent-owner and child fixtures only: no native filesystem, process,
// provider, journal, package or production route is exercised here.
func readAuthority(c *clock, original *execution) *execution {
	p, a := original.p.Clone(), original.a.Clone()
	p.Grant.Capabilities = []authority.Capability{authority.Read}
	p.Grant.Commands = authority.NoCommands
	p.Grant.ExpiresAt = c.now.Add(authority.OrdinaryExecutionLifetime)
	a.Capabilities = []authority.Capability{authority.Read}
	a.Commands = authority.NoCommands
	a.Workspaces[0].ShellVerified = false
	return &execution{binding: original.binding, deadline: p.Grant.ExpiresAt, p: p, a: a}
}

func observer(t *testing.T, s *Service, e *execution) *Observer {
	t.Helper()
	o, err := s.Observer(e, workspaceFixture(s, e))
	if err != nil {
		t.Fatal(err)
	}
	return o
}

type observedWorkspace struct {
	value  *ObservedWorkspace
	e      *execution
	calls  int
	err    error
	before func()
}

func workspaceFixture(s *Service, e *execution) *observedWorkspace {
	seal := s.intent.Seal
	return &observedWorkspace{value: &ObservedWorkspace{WorkspaceID: seal.WorkspaceID, Root: seal.Root, RootIdentity: seal.RootIdentity}, e: e}
}

func (w *observedWorkspace) ObserveWorkspace(context.Context) (*ObservedWorkspace, error) {
	if w.e.inCallback {
		panic("physical workspace IO under authority gate")
	}
	w.calls++
	if w.before != nil {
		w.before()
	}
	if w.err != nil || w.value == nil {
		return nil, w.err
	}
	copy := *w.value
	return &copy, nil
}

func TestRetainedReadPhysicalQualificationRequiresReadAndRechecksOwners(t *testing.T) {
	for _, mode := range []string{"denied-before", "withdraw-during-probe", "expire-during-probe", "policy-during-probe", "physical-policy-during-probe"} {
		t.Run(mode, func(t *testing.T) {
			s, c, original, r, p := setup(t)
			start(t, s)
			c.now = original.deadline
			read := readAuthority(c, original)
			workspace := workspaceFixture(s, read)
			o, err := s.Observer(read, workspace)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "denied-before":
				read.p.Grant.Capabilities = nil
			case "withdraw-during-probe":
				workspace.before = func() { read.revoked = true }
			case "expire-during-probe":
				workspace.before = func() { c.now = read.deadline }
			case "policy-during-probe":
				workspace.before = func() { read.a.Capabilities = nil }
			case "physical-policy-during-probe":
				workspace.before = func() { read.a.Workspaces[0].RootIdentity.Inode = "3" }
			}
			out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
			wantProbes := 1
			if mode == "denied-before" {
				wantProbes = 0
			}
			if out != nil || err == nil || workspace.calls != wantProbes || p.child.reads != 0 || p.calls != 1 || r.calls != 1 || p.child.cancels != 0 {
				t.Fatal("physical probe bypassed current READ gates", out, err)
			}
		})
	}
}

func TestRetainedReadRequiresFreshPhysicalRootEvenWhenApprovalIsUnchanged(t *testing.T) {
	changes := map[string]func(*observedWorkspace){
		"workspace":   func(w *observedWorkspace) { w.value.WorkspaceID = "other" },
		"root":        func(w *observedWorkspace) { w.value.Root = "/other" },
		"device":      func(w *observedWorkspace) { w.value.RootIdentity.Device = "3" },
		"inode":       func(w *observedWorkspace) { w.value.RootIdentity.Inode = "3" },
		"missing":     func(w *observedWorkspace) { w.value = nil },
		"unavailable": func(w *observedWorkspace) { w.err = errors.New("private physical probe detail") },
	}
	for name, change := range changes {
		for _, phase := range []string{"before", "during"} {
			t.Run(name+"/"+phase, func(t *testing.T) {
				s, c, original, r, p := setup(t)
				start(t, s)
				c.now = original.deadline
				read := readAuthority(c, original)
				workspace := workspaceFixture(s, read)
				o, err := s.Observer(read, workspace)
				if err != nil {
					t.Fatal(err)
				}
				approval := read.a.Clone()
				if phase == "before" {
					change(workspace)
				} else {
					p.child.afterRead = func() { change(workspace) }
				}
				out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
				wantReads, wantProbes := 0, 1
				if phase == "during" {
					wantReads, wantProbes = 1, 2
				}
				if out != nil || err == nil || err.Error() == "private physical probe detail" || p.child.reads != wantReads || workspace.calls != wantProbes ||
					!authority.SameApprovalPolicy(approval, read.a) || p.calls != 1 || r.calls != 1 || p.child.cancels != 0 {
					t.Fatal("saved approval substituted for current physical proof", out, err)
				}
			})
		}
	}
}

func TestRetainedReadAfterExecutionExpiryPreservesIntentAndZeroNewEffects(t *testing.T) {
	s, c, original, r, p := setup(t)
	start(t, s)
	intent := s.intent
	c.now = intent.Deadline.Add(time.Millisecond)
	if out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"}); err == nil || out != nil || p.child.reads != 0 {
		t.Fatal("legacy read did not expire", out, err)
	}
	read := readAuthority(c, original)
	p.child.e = read // Child IO must remain outside the fresh READ gate too.
	p.child.observation.Stdout = []byte("retained")
	p.child.observation.StdoutBytes = 8
	p.child.observation.StdoutNext = 8
	o := observer(t, s, read)
	workspace := o.workspace.(*observedWorkspace)
	for i := 0; i < 2; i++ {
		out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
		if err != nil || out.State != Running || string(out.Observation.Stdout) != "retained" {
			t.Fatal(out, err)
		}
		out.Observation.Stdout[0] = 'X'
	}
	if _, err := s.Start(context.Background(), StartRequest{"operation"}); err == nil {
		t.Fatal("READ renewed start disclosure")
	}
	if !sameIntent(intent, s.intent) || !p.deadline.Equal(intent.Deadline) || r.calls != 1 || p.calls != 1 || p.child.cancels != 0 || p.child.reads != 2 || s.lease != original {
		t.Fatal("observation changed original identity or produced effects")
	}
	if workspace.calls != 4 {
		t.Fatal("physical workspace was not rechecked around each child read")
	}
	c.now = read.deadline
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); err == nil || out != nil || p.child.reads != 2 {
		t.Fatal("READ lifetime did not expire", out, err)
	}
}

func TestRetainedReadRefusesCrossedSelectionAndHandle(t *testing.T) {
	for _, field := range []string{"owner", "session", "task", "epoch", "participant", "turn"} {
		t.Run(field, func(t *testing.T) {
			s, c, original, r, p := setup(t)
			start(t, s)
			c.now = original.deadline
			read := readAuthority(c, original)
			switch field {
			case "owner":
				read.binding.OwnerID = "other"
			case "session":
				read.binding.SessionID = "other"
			case "task":
				read.binding.TaskID = "other"
			case "epoch":
				read.binding.TaskEpoch++
			case "participant":
				read.binding.ParticipantID = "other"
			case "turn":
				read.binding.TurnID = "other"
			}
			if out, err := s.Observer(read, workspaceFixture(s, read)); err == nil || out != nil || p.child.reads != 0 || p.calls != 1 || r.calls != 1 {
				t.Fatal("crossed binding selected retained process", out, err)
			}
		})
	}
	s, c, original, _, p := setup(t)
	start(t, s)
	c.now = original.deadline
	o := observer(t, s, readAuthority(c, original))
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "foreign-child"}); err == nil || out != nil || p.child.reads != 0 {
		t.Fatal("body selected another child", out, err)
	}
	p.child.handle = "replacement"
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || p.child.reads != 0 {
		t.Fatal("drifting handle read", out, err)
	}
	p.child.handle = "owned-child"
	out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Unknown {
		t.Fatal("handle drift uncertainty cleared", out, err)
	}
}

func TestRetainedReadRechecksAuthorityBeforeReadAndAfterObservation(t *testing.T) {
	changes := map[string]func(*execution){
		"withdrawal":         func(e *execution) { e.revoked = true },
		"read-grant":         func(e *execution) { e.p.Grant.Capabilities = nil },
		"read-approval":      func(e *execution) { e.a.Capabilities = nil },
		"grant-expiry":       func(e *execution) { e.p.Grant.ExpiresAt = e.deadline.Add(-authority.OrdinaryExecutionLifetime) },
		"approval-expiry":    func(e *execution) { e.a.ExpiresAt = e.deadline.Add(-authority.OrdinaryExecutionLifetime) },
		"owner":              func(e *execution) { e.p.Grant.OwnerID = "other"; e.a.OwnerID = "other" },
		"approval-owner":     func(e *execution) { e.a.OwnerID = "other" },
		"task":               func(e *execution) { e.p.Grant.TaskID = "other" },
		"session":            func(e *execution) { e.p.Grant.SessionID = "other" },
		"epoch":              func(e *execution) { e.p.Grant.TaskEpoch++ },
		"participant":        func(e *execution) { e.p.ParticipantID = "other" },
		"generation":         func(e *execution) { e.a.Generation++ },
		"computer":           func(e *execution) { e.a.ComputerID = "other" },
		"workspace-grant":    func(e *execution) { e.p.Grant.Workspaces[0].WorkspaceID = "other" },
		"workspace-approval": func(e *execution) { e.a.Workspaces[0].WorkspaceID = "other" },
		"root":               func(e *execution) { e.a.Workspaces[0].Root = "/workspace" },
		"physical-device":    func(e *execution) { e.a.Workspaces[0].RootIdentity.Device = "3" },
		"physical-inode":     func(e *execution) { e.a.Workspaces[0].RootIdentity.Inode = "3" },
		"path-exclusion": func(e *execution) {
			e.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "code", Path: "/workspace/code"}}
		},
		"binding-drift":  func(e *execution) { e.binding.TurnID = "other" },
		"deadline-drift": func(e *execution) { e.deadline = e.deadline.Add(time.Hour) },
	}
	for name, change := range changes {
		for _, phase := range []string{"before", "during"} {
			t.Run(name+"/"+phase, func(t *testing.T) {
				s, c, original, r, p := setup(t)
				start(t, s)
				intent := s.intent
				c.now = original.deadline
				read := readAuthority(c, original)
				p.child.e = read
				o := observer(t, s, read)
				if phase == "before" {
					change(read)
				} else {
					p.child.afterRead = func() { change(read) }
				}
				out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
				wantReads := 0
				if phase == "during" {
					wantReads = 1
				}
				if out != nil || err == nil || p.child.reads != wantReads || p.calls != 1 || r.calls != 1 || p.child.cancels != 0 || !sameIntent(intent, s.intent) {
					t.Fatal("stale or crossed READ authority disclosed/acted", out, err)
				}
			})
		}
	}
}

func TestRetainedReadUnknownAndCancelFencesRemainSticky(t *testing.T) {
	for _, mode := range []string{"read-error", "malformed", "cleanup", "drain", "cancel-error"} {
		t.Run(mode, func(t *testing.T) {
			s, c, original, r, p := setup(t)
			start(t, s)
			c.now = original.deadline
			read := readAuthority(c, original)
			o := observer(t, s, read)
			code := 0
			terminal := Observation{Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true}
			p.child.observation = terminal
			switch mode {
			case "read-error":
				p.child.readError = errors.New("synthetic lost read acknowledgement")
			case "malformed":
				p.child.observation.StdoutNext = 1
			case "cleanup":
				p.child.observation.DescendantCleanup = CleanupUnverified
			case "drain":
				p.child.observation.OutputDrained = false
			case "cancel-error":
				p.child.cancelError = errors.New("synthetic lost cancel acknowledgement")
				_, err := s.Cancel(context.Background(), CancelRequest{"owned-child"})
				unknown(t, err)
			}
			out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
			if mode == "read-error" || mode == "malformed" {
				unknown(t, err)
				if out != nil {
					t.Fatal("bad observation disclosed")
				}
			} else if err != nil || out.State != Unknown {
				t.Fatal(out, err)
			}
			p.child.readError = nil
			p.child.observation = terminal
			// A later ordinary authority and positive observation cannot erase
			// the SAME retained service's earlier irreversible uncertainty.
			c.now = read.deadline
			o = observer(t, s, readAuthority(c, original))
			out, err = o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
			if err != nil || out.State != Unknown || s.terminal || p.calls != 1 || r.calls != 1 {
				t.Fatal("retained unknown upgraded", out, err)
			}
			if mode == "cancel-error" {
				s.Cancel(context.Background(), CancelRequest{"owned-child"})
				if p.child.cancels != 1 {
					t.Fatal("cancel fence replayed")
				}
			}
		})
	}
}

func TestRetainedReadAuthorityPortFailuresNeverDisclose(t *testing.T) {
	for _, mode := range []string{"zero", "twice", "raw-error", "swallowed-denial", "expired-during-read", "cancelled-during-read"} {
		t.Run(mode, func(t *testing.T) {
			s, c, original, r, p := setup(t)
			start(t, s)
			c.now = original.deadline
			read := readAuthority(c, original)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var current ObservationAuthority = read
			switch mode {
			case "zero":
				read.count = -1
			case "twice":
				read.count = 2
			case "raw-error":
				read.rawError = errors.New("private host detail")
			case "swallowed-denial":
				read.revoked = true
				current = swallowedObservation{read}
			case "expired-during-read":
				p.child.afterRead = func() { c.now = read.deadline }
			case "cancelled-during-read":
				p.child.afterRead = cancel
			}
			o, err := s.Observer(current, workspaceFixture(s, read))
			if err != nil {
				t.Fatal(err)
			}
			out, err := o.Read(ctx, ReadRequest{Handle: "owned-child"})
			if out != nil || err == nil || err.Error() == "private host detail" || p.calls != 1 || r.calls != 1 || p.child.cancels != 0 {
				t.Fatal("authority port failure accepted", out, err)
			}
			if mode != "expired-during-read" && mode != "cancelled-during-read" && p.child.reads != 0 {
				t.Fatal("read after preflight failure")
			}
		})
	}
}

type swallowedObservation struct{ *execution }

func (e swallowedObservation) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	e.execution.WithSnapshot(ctx, id, inspect)
	return nil
}

func TestObserverSelectionIsBoundedAndHasOnlyRead(t *testing.T) {
	s, c, original, _, _ := setup(t)
	if out, err := s.Observer(nil, workspaceFixture(s, original)); out != nil || err == nil {
		t.Fatal("nil authority accepted")
	}
	if out, err := s.Observer(original, nil); out != nil || err == nil {
		t.Fatal("nil physical workspace selected")
	}
	for _, mode := range []string{"expired", "extended"} {
		read := readAuthority(c, original)
		if mode == "expired" {
			read.deadline = c.now
		} else {
			read.deadline = read.deadline.Add(time.Millisecond)
		}
		if out, err := s.Observer(read, workspaceFixture(s, read)); out != nil || err == nil {
			t.Fatal("non-ordinary READ lifetime accepted", mode)
		}
	}
	o := observer(t, s, readAuthority(c, original))
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil {
		t.Fatal("observer cold-restored a child")
	}
	shape := reflect.TypeOf(o)
	if shape.NumMethod() != 1 || shape.Method(0).Name != "Read" {
		t.Fatal("observer exposes process effects")
	}
	var absent *Observer
	if out, err := absent.Read(context.Background(), ReadRequest{}); out != nil || err == nil {
		t.Fatal("nil observer read")
	}
}

func TestRetainedInvocationReadPreservesPayloadAndOriginalAdmission(t *testing.T) {
	for _, phase := range []string{"before", "during"} {
		t.Run(phase, func(t *testing.T) {
			s, builder, c, original, r, request := prepareSetup(t)
			if _, err := s.Prepare(context.Background(), request); err != nil {
				t.Fatal(err)
			}
			start(t, s)
			intent, invocation := s.intent, s.invocation.Clone()
			request.Invocation.Arguments[1] = "body-replacement"
			request.Invocation.Input[0] = 'X'
			c.now = intent.Deadline
			read := readAuthority(c, original)
			o := observer(t, s, read)
			if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); err != nil || out.State != Running {
				t.Fatal(out, err)
			}
			change := func() { read.p.Grant.AuthorityID = "different-admission" }
			if phase == "before" {
				change()
			} else {
				builder.selected.child.afterRead = change
			}
			if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); err == nil || out != nil {
				t.Fatal("different invocation admission disclosed", out, err)
			}
			if !sameIntent(intent, s.intent) || !sameInvocation(invocation, *s.invocation) || !sameInvocation(invocation, builder.captured) || !sameInvocation(invocation, builder.selected.Invocation()) ||
				builder.calls != 1 || builder.selected.calls != 1 || r.calls != 1 || builder.selected.child.cancels != 0 {
				t.Fatal("observation rebound invocation or replayed an effect")
			}
		})
	}
}

type observationAdmission struct {
	binding   port.TaskBinding
	withdrawn bool
}

func (a *observationAdmission) WithCurrent(_ context.Context, inspect func(*port.TaskBinding) error) error {
	if a.withdrawn {
		return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	b := a.binding
	return inspect(&b)
}

func TestRetainedReadUsesExistingIssuerWithoutRenewingProcessLease(t *testing.T) {
	_, c, access, r, p := setup(t)
	access.p.Grant.Capabilities = []authority.Capability{authority.Shell, authority.Read}
	access.a.Capabilities = []authority.Capability{authority.Shell, authority.Read}
	admission := &observationAdmission{binding: access.binding}
	issuer, err := executionsvc.New(access, admission, c, executionsvc.Ceiling{Participant: access.p.Clone(), Approval: access.a.Clone()})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := issuer.Admit(context.Background(), authority.Shell)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New("operation", initial, p, r, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	start(t, s)
	intent := s.intent
	c.now = initial.Deadline().Add(time.Millisecond)
	if out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil {
		t.Fatal("original execution lease still disclosed", out, err)
	}
	read, err := issuer.Admit(context.Background(), authority.Read)
	if err != nil {
		t.Fatal(err)
	}
	o, err := s.Observer(read, workspaceFixture(s, access))
	if err != nil {
		t.Fatal(err)
	}
	// Positive terminal facts are supplied only by the pure child fixture.
	code := 0
	p.child.observation = Observation{Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true}
	out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Terminal || !s.terminal || !sameIntent(intent, s.intent) || s.lease != initial || p.calls != 1 || r.calls != 1 || p.child.cancels != 0 {
		t.Fatal("fresh READ replaced original execution", out, err)
	}
	out.Observation.ExitCode = nil
	p.child.afterRead = func() { admission.withdrawn = true }
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || p.calls != 1 || r.calls != 1 {
		t.Fatal("issuer withdrawal failed to fence retained disclosure", out, err)
	}
}

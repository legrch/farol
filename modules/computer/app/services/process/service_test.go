package process

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Every producer below is an in-memory boundary double. These tests do NOT
// spawn native children or qualify a sandbox, journal, provider or supervisor.
type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

type execution struct {
	binding             port.TaskBinding
	deadline            time.Time
	p                   authority.Participant
	a                   authority.Approval
	inCallback, revoked bool
	count               int
	rawError            error
	after               func()
}

func (e *execution) Binding() port.TaskBinding { return e.binding }
func (e *execution) Deadline() time.Time       { return e.deadline }
func (e *execution) WithSnapshot(_ context.Context, _ string, inspect func(port.AccessSnapshot) error) error {
	if e.rawError != nil {
		return e.rawError
	}
	e.inCallback = true
	defer func() { e.inCallback = false }()
	times := 1
	if e.count != 0 {
		times = e.count
	}
	var err error
	for i := 0; i < times; i++ {
		if e.revoked {
			err = inspect(port.AccessSnapshot{})
			continue
		}
		p, a := e.p.Clone(), e.a.Clone()
		err = inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
	}
	if e.after != nil {
		e.after()
	}
	return err
}

type reservation struct {
	e       *execution
	status  ReservationStatus
	calls   int
	before  func()
	corrupt bool
	err     error
}

func (r *reservation) Reserve(_ context.Context, intent Intent) (*ReservationReceipt, error) {
	if r.e.inCallback {
		panic("journal under authority gate")
	}
	r.calls++
	if r.before != nil {
		r.before()
	}
	if r.err != nil {
		return nil, r.err
	}
	if r.corrupt {
		intent.OperationID = "different"
	}
	return &ReservationReceipt{Status: r.status, Intent: intent}, nil
}

type prepared struct {
	e        *execution
	seal     Seal
	child    *child
	calls    int
	err      error
	before   func()
	deadline time.Time
}

func (p *prepared) Seal() Seal { return p.seal }
func (p *prepared) Spawn(ctx context.Context, r SpawnRequest) (Child, error) {
	if p.e.inCallback {
		panic("spawn under authority gate")
	}
	p.calls++
	p.deadline = r.Deadline
	if p.before != nil {
		p.before()
	}
	if err := r.Check(ctx); err != nil {
		return nil, &NativeFailure{}
	}
	if p.err != nil {
		return nil, p.err
	}
	return p.child, nil
}

type child struct {
	handle                 string
	e                      *execution
	observation            Observation
	reads, cancels         int
	afterRead              func()
	readError, cancelError error
	cancelStatus           CancelStatus
}

func (c *child) Handle() string {
	if c.handle != "" {
		return c.handle
	}
	return "owned-child"
}
func (c *child) Read(_ context.Context, w Window) (*Observation, error) {
	if c.e.inCallback {
		panic("native read under authority gate")
	}
	c.reads++
	if c.afterRead != nil {
		c.afterRead()
	}
	if c.readError != nil {
		return nil, c.readError
	}
	out := c.observation
	out.Handle = c.Handle()
	out.StdoutOffset = w.StdoutOffset
	out.StderrOffset = w.StderrOffset
	return &out, nil
}
func (c *child) Cancel(context.Context) (*CancelReceipt, error) {
	c.cancels++
	if c.cancelError != nil {
		return nil, c.cancelError
	}
	return &CancelReceipt{Handle: c.Handle(), Status: c.cancelStatus}, nil
}
func setup(t *testing.T) (*Service, *clock, *execution, *reservation, *prepared) {
	t.Helper()
	now := time.UnixMilli(1900000000000)
	c := &clock{now}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7}, ParticipantID: "participant", TurnID: "turn"}
	policy := authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "code", Root: "/workspace/code", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Network: authority.NoNetwork, ExpiresAt: now.Add(12 * time.Hour)}
	participant := authority.Participant{ParticipantID: "participant", Role: authority.Main, MutationOwnership: authority.NoOwnership, Grant: authority.Grant{Identity: binding.Identity, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 4, Policy: policy}}
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 4, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "code", Root: "/workspace/code", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}, ShellVerified: true}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Network: authority.NoNetwork, ExpiresAt: now.Add(12 * time.Hour)}
	e := &execution{binding: binding, deadline: now.Add(15 * time.Second), p: participant, a: approval}
	r := &reservation{e: e, status: Reserved}
	p := &prepared{e: e, seal: Seal{Digest: strings.Repeat("a", 64), WorkspaceID: "code", Root: "/workspace/code", Cwd: "/workspace/code", RootIdentity: approval.Workspaces[0].RootIdentity}}
	p.child = &child{e: e, cancelStatus: CancelRequested, observation: Observation{Root: RootRunning, GroupCleanup: CleanupPending, DescendantCleanup: CleanupPending}}
	service, err := New("operation", e, p, r, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	return service, c, e, r, p
}
func start(t *testing.T, s *Service) {
	t.Helper()
	out, err := s.Start(context.Background(), StartRequest{"operation"})
	if err != nil || out == nil || out.Handle != "owned-child" {
		t.Fatalf("start: %v %v", out, err)
	}
}
func unknown(t *testing.T, err error) {
	t.Helper()
	var failure *Failure
	if !errors.As(err, &failure) || !failure.Unknown {
		t.Fatalf("not classified unknown: %v", err)
	}
}
func TestOneAttemptAndImmutableDeadline(t *testing.T) {
	s, _, e, r, p := setup(t)
	original := e.deadline
	e.deadline = e.deadline.Add(time.Hour)
	start(t, s)
	start(t, s)
	if p.calls != 1 || r.calls != 1 || !p.deadline.Equal(original) {
		t.Fatalf("replayed/reset deadline: %d %d %v", p.calls, r.calls, p.deadline)
	}
	if _, err := s.Start(context.Background(), StartRequest{"other"}); err == nil {
		t.Fatal("crossed operation")
	}
	if p.calls != 1 {
		t.Fatal("crossed operation executed")
	}
}
func TestPublicationUnknownExistingAndLostSpawnACKNeverReplay(t *testing.T) {
	for _, mode := range []string{"existing", "publication-error", "crossed-receipt", "spawn-unknown", "spawn-refused", "filesystem-refused", "filesystem-unknown"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, r, p := setup(t)
			switch mode {
			case "existing":
				r.status = Existing
			case "publication-error":
				r.err = errors.New("publish ACK lost")
			case "crossed-receipt":
				r.corrupt = true
			case "spawn-unknown":
				p.err = &NativeFailure{Unknown: true}
			case "spawn-refused":
				p.err = &NativeFailure{}
			case "filesystem-refused":
				p.err = &NativeFailure{FilesystemUnsupported: true}
			case "filesystem-unknown":
				p.err = &NativeFailure{Unknown: true, FilesystemUnsupported: true}
			}
			_, first := s.Start(context.Background(), StartRequest{"operation"})
			if first == nil {
				t.Fatal("accepted")
			}
			if mode != "spawn-refused" && mode != "filesystem-refused" {
				unknown(t, first)
			}
			if mode == "filesystem-refused" && first.Error() != "PROCESS_FILESYSTEM_UNSUPPORTED" {
				t.Fatal("filesystem refusal lost", first)
			}
			_, second := s.Start(context.Background(), StartRequest{"operation"})
			if second != first {
				t.Fatal("forgot irreversible outcome")
			}
			if r.calls != 1 || p.calls > 1 {
				t.Fatal("replayed")
			}
		})
	}
}
func TestRestartObservesExistingReservationOnly(t *testing.T) {
	s, c, e, r, p := setup(t)
	start(t, s)
	r.status = Existing
	restarted, err := New("operation", e, p, r, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	_, err = restarted.Start(context.Background(), StartRequest{"operation"})
	unknown(t, err)
	if p.calls != 1 {
		t.Fatal("restart redispatched")
	}
}
func TestRevocationGenerationAndClockExpiryBeforeEffect(t *testing.T) {
	for _, mode := range []string{"revoked", "generation", "physical-root", "expiry", "reserve-revoke", "final-guard-revoke"} {
		t.Run(mode, func(t *testing.T) {
			s, c, e, r, p := setup(t)
			switch mode {
			case "revoked":
				e.revoked = true
			case "generation":
				e.a.Generation++
			case "physical-root":
				e.a.Workspaces[0].RootIdentity.Inode = "3"
			case "expiry":
				c.now = e.deadline
			case "reserve-revoke":
				r.before = func() { e.revoked = true }
			case "final-guard-revoke":
				p.before = func() { e.revoked = true }
			}
			if out, err := s.Start(context.Background(), StartRequest{"operation"}); err == nil || out != nil {
				t.Fatal("accepted stale authority")
			}
			if mode != "final-guard-revoke" && p.calls != 0 {
				t.Fatal("native attempt after denial")
			}
			if _, err := s.Start(context.Background(), StartRequest{"operation"}); err == nil {
				t.Fatal("refusal reset")
			}
			if p.calls > 1 {
				t.Fatal("retried final guard")
			}
		})
	}
}
func TestCurrentOwnerContractFailuresDoNotDiscloseOrExecute(t *testing.T) {
	for _, mode := range []string{"twice", "zero", "raw-error"} {
		t.Run(mode, func(t *testing.T) {
			s, _, e, _, p := setup(t)
			if mode == "twice" {
				e.count = 2
			} else if mode == "zero" {
				e.count = -1
			} else {
				e.rawError = errors.New("private owner unavailable")
			}
			out, err := s.Start(context.Background(), StartRequest{"operation"})
			if out != nil || err == nil || p.calls != 0 {
				t.Fatal("owner failure accepted")
			}
			if strings.Contains(err.Error(), "private") {
				t.Fatal("raw error leaked")
			}
		})
	}
}
func TestRootWaitIsNotCohortTerminal(t *testing.T) {
	s, _, _, _, p := setup(t)
	start(t, s)
	code := 0
	p.child.observation = Observation{Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupUnverified, OutputDrained: true}
	out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Unknown || !out.Observation.Waited {
		t.Fatalf("false terminal: %v %v", out, err)
	}
	p.child.observation.DescendantCleanup = CleanupConfirmed
	out, err = s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Unknown {
		t.Fatal("cleared unknown using later positive")
	}
}
func TestQualifiedBoundaryDoubleCanSupplyTerminalFacts(t *testing.T) {
	s, _, _, _, p := setup(t)
	start(t, s)
	code := 0
	p.child.observation = Observation{Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true}
	out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Terminal {
		t.Fatal(out, err)
	}
	// A parser positive only. The real direct producer never supplies cohort proof.
}
func TestFinalDisclosureRevocationAndMalformedOffsets(t *testing.T) {
	s, _, e, _, p := setup(t)
	start(t, s)
	p.child.observation.Stdout = []byte("abc")
	p.child.observation.StdoutBytes = 3
	p.child.observation.StdoutNext = 3
	p.child.afterRead = func() { e.revoked = true }
	out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err == nil || out != nil {
		t.Fatal("disclosed after revoke")
	}
	e.revoked = false
	p.child.afterRead = nil
	p.child.observation.StdoutNext = 4
	out, err = s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if out != nil {
		t.Fatal("malformed bytes disclosed")
	}
	unknown(t, err)
}
func TestCancelRequestUnknownIsStickyAndCleanupOutlivesDisclosureLease(t *testing.T) {
	s, c, e, _, p := setup(t)
	start(t, s)
	c.now = e.deadline
	e.revoked = true
	out, err := s.Cancel(context.Background(), CancelRequest{"owned-child"})
	if err != nil || out.Status != CancelRequested {
		t.Fatal(out, err)
	}
	out, err = s.Cancel(context.Background(), CancelRequest{"owned-child"})
	if err != nil || out.Status != CancelRequested || p.child.cancels != 1 {
		t.Fatal("cancel replay")
	}
	if out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"}); err == nil || out != nil {
		t.Fatal("cleanup renewed output authority")
	}
}
func TestCancelRefusalStaysUnknownAndAlreadyTerminalDoesNotPublishCompletion(t *testing.T) {
	for _, mode := range []string{"refused", "already-terminal"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, _, p := setup(t)
			start(t, s)
			if mode == "refused" {
				p.child.cancelError = errors.New("signal refused")
			} else {
				p.child.cancelStatus = AlreadyTerminal
			}
			out, err := s.Cancel(context.Background(), CancelRequest{"owned-child"})
			if mode == "refused" {
				unknown(t, err)
			} else if err != nil || out.Status != AlreadyTerminal || s.terminal || s.uncertain {
				t.Fatal("no-effect cancel ACK was lost or published terminal state")
			}
			s.Cancel(context.Background(), CancelRequest{"owned-child"})
			if p.child.cancels != 1 {
				t.Fatal("retried cancellation")
			}
		})
	}
}

func TestAlreadyTerminalCancelAllowsIndependentTerminalRead(t *testing.T) {
	s, _, _, _, p := setup(t)
	start(t, s)
	p.child.cancelStatus = AlreadyTerminal
	ack, err := s.Cancel(context.Background(), CancelRequest{"owned-child"})
	if err != nil || ack.Status != AlreadyTerminal || s.terminal {
		t.Fatal("cancel alone supplied terminal publication", ack, err)
	}
	code := 0
	p.child.observation = Observation{Handle: "owned-child", Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true}
	out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Terminal || !s.terminal || s.uncertain {
		t.Fatal("independent terminal observation was poisoned by no-effect cancel", out, err)
	}
	if ack, err = s.Cancel(context.Background(), CancelRequest{"owned-child"}); err != nil || ack.Status != AlreadyTerminal || p.child.cancels != 1 {
		t.Fatal("cached no-effect cancellation was repeated", ack, err)
	}
}

func TestOwningHandleCannotDriftOrSelectReplacement(t *testing.T) {
	s, _, _, _, p := setup(t)
	start(t, s)
	p.child.handle = "replacement"
	if out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || p.child.reads != 0 {
		t.Fatal("drifting producer was read")
	}
	if out, err := s.Cancel(context.Background(), CancelRequest{Handle: "replacement"}); out != nil || err == nil || p.child.cancels != 0 {
		t.Fatal("body selected replacement")
	}
	if out, err := s.Start(context.Background(), StartRequest{"operation"}); out != nil || err == nil || p.calls != 1 {
		t.Fatal("start reselected owning handle")
	}
	p.child.handle = "owned-child"
	if out, err := s.Start(context.Background(), StartRequest{"operation"}); out != nil || err == nil {
		t.Fatal("handle drift unknown was cleared")
	}
}
func TestRootExitWithIncompleteOutputCannotBeTerminal(t *testing.T) {
	s, _, _, _, p := setup(t)
	start(t, s)
	code := 0
	p.child.observation = Observation{Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed}
	out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Unknown {
		t.Fatal("unqualified output drain became terminal")
	}
}

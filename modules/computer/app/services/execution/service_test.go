package execution_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/repos/access"
)

// A trusted task-owner projection is modeled here, not implemented as a second
// production task engine. These fixture IDs do not prove owner/provider admission.
type taskOwner struct {
	mutex   sync.Mutex
	binding *port.TaskBinding
	err     error
}

func (o *taskOwner) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	o.mutex.Lock()
	defer o.mutex.Unlock()
	if o.err != nil {
		return o.err
	}
	if o.binding == nil {
		return inspect(nil)
	}
	copy := *o.binding
	return inspect(&copy)
}
func (o *taskOwner) update(change func(*port.TaskBinding)) {
	o.mutex.Lock()
	defer o.mutex.Unlock()
	change(o.binding)
}

type clock struct{ ms atomic.Int64 }

func (c *clock) Now() time.Time          { return time.UnixMilli(c.ms.Load()) }
func (c *clock) advance(d time.Duration) { c.ms.Add(d.Milliseconds()) }

type fixture struct {
	service *executionsvc.Service
	access  *access.Repository
	tasks   *taskOwner
	clock   *clock
	ceiling executionsvc.Ceiling
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	c := &clock{}
	c.ms.Store(1700000000000)
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Read, authority.List, authority.Search, authority.Verify, authority.Write, authority.Shell}, Commands: authority.WorkspaceCommands, Network: authority.NoNetwork, ExpiresAt: c.Now().Add(time.Hour)}
	n := authority.Admission{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7}, AuthorityID: "authority", ComputerID: a.ComputerID, ComputerGeneration: a.Generation, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: append([]authority.Capability(nil), a.Capabilities...), Commands: a.Commands, Network: a.Network, ExpiresAt: c.Now().Add(time.Second)}}
	g, err := authority.Derive(a, n, c.Now())
	if err != nil {
		t.Fatal(err)
	}
	p, err := authority.Create(*g, authority.ParticipantAdmission{ParticipantID: "main", Role: authority.Main, MutationOwnership: authority.TaskOwnership})
	if err != nil {
		t.Fatal(err)
	}
	r := access.New()
	r.PutParticipant(*p)
	r.PutApproval(a)
	tasks := &taskOwner{binding: &port.TaskBinding{Identity: n.Identity, ParticipantID: p.ParticipantID, TurnID: "turn-1"}}
	ceiling := executionsvc.Ceiling{Participant: *p, Approval: a}
	s, err := executionsvc.New(r, tasks, c, ceiling)
	if err != nil {
		t.Fatal(err)
	}
	return fixture{s, r, tasks, c, ceiling}
}
func refused(t *testing.T, err error, code string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != code || f.Retry != "never" {
		t.Fatalf("want %s/never, got %v", code, err)
	}
}
func lease(t *testing.T, f fixture, kind authority.Capability) *executionsvc.Lease {
	t.Helper()
	l, err := f.service.Admit(context.Background(), kind)
	if err != nil || l == nil {
		t.Fatalf("admit: %v", err)
	}
	return l
}
func observe(l *executionsvc.Lease) error {
	return l.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { return nil })
}
func TestExpiryReissueNewTurnAndReconnectKeepOneCeiling(t *testing.T) {
	f := newFixture(t)
	before := f.ceiling.Participant.Grant.ExpiresAt
	f.clock.advance(2 * time.Second)
	for i := 0; i < 3; i++ {
		if i == 1 {
			f.tasks.update(func(b *port.TaskBinding) { b.TurnID = "turn-2" })
		}
		if i == 2 {
			var err error
			f.service, err = executionsvc.New(f.access, f.tasks, f.clock, f.ceiling)
			if err != nil {
				t.Fatal(err)
			}
		}
		l := lease(t, f, authority.Read)
		if !l.Deadline().Equal(f.clock.Now().Add(15*time.Second)) || !authority.SameParticipantCeiling(l.Participant(), f.ceiling.Participant) {
			t.Fatal("renewed/widened ceiling incorrectly")
		}
		if err := observe(l); err != nil {
			t.Fatal(err)
		}
		f.clock.advance(2 * time.Second)
	}
	var stored time.Time
	err := f.access.WithSnapshot(context.Background(), "main", func(v port.AccessSnapshot) error { stored = v.Participant.Grant.ExpiresAt; return nil })
	if err != nil || !stored.Equal(before) {
		t.Fatal("durable participant TTL changed")
	}
}
func TestConcurrentRenewalCannotExtendIssuedLease(t *testing.T) {
	f := newFixture(t)
	first := lease(t, f, authority.Read)
	deadline := first.Deadline()
	f.clock.advance(10 * time.Second)
	var wg sync.WaitGroup
	leases := make(chan *executionsvc.Lease, 32)
	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Go(func() {
			l, err := f.service.Admit(context.Background(), authority.Read)
			if err != nil {
				errs <- err
			} else {
				leases <- l
			}
		})
	}
	wg.Wait()
	close(leases)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	for l := range leases {
		if !l.Deadline().Equal(f.clock.Now().Add(15 * time.Second)) {
			t.Fatal("concurrent lease shared deadline")
		}
	}
	f.clock.advance(5 * time.Second)
	refused(t, observe(first), "AUTHORITY_EXPIRED")
	if !first.Deadline().Equal(deadline) {
		t.Fatal("first lease extended")
	}
	if err := observe(lease(t, f, authority.Read)); err != nil {
		t.Fatal(err)
	}
}
func TestCompositeAndMutableBudgetsRemainFixed(t *testing.T) {
	f := newFixture(t)
	for _, kind := range []authority.Capability{authority.Read, authority.List, authority.Search, authority.Verify, authority.Write, authority.Shell} {
		l := lease(t, f, kind)
		want := 15 * time.Second
		if kind == authority.Verify {
			want = 120 * time.Second
		}
		if !l.Deadline().Equal(f.clock.Now().Add(want)) {
			t.Fatal("wrong operation budget")
		}
	}
	refused(t, func() error { _, err := f.service.Admit(context.Background(), authority.NetworkUse); return err }(), "AUTHORITY_CAPABILITY_DENIED")
}
func TestOuterExpiryDoesNotStopAdmittedExecution(t *testing.T) {
	f := newFixture(t)
	l := lease(t, f, authority.Read)
	f.clock.advance(2 * time.Second)
	if err := observe(l); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(13 * time.Second)
	refused(t, observe(l), "AUTHORITY_EXPIRED")
}
func TestAllCurrentChangesWinBeforeAndAfterLeaseAdmission(t *testing.T) {
	changes := []struct {
		name, code string
		change     func(fixture)
	}{
		{"task revoke", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.binding = nil }},
		{"task unavailable", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", func(f fixture) { f.tasks.err = errors.New("private") }},
		{"turn changed", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.update(func(b *port.TaskBinding) { b.TurnID = "other" }) }},
		{"identity changed", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.update(func(b *port.TaskBinding) { b.TaskEpoch++ }) }},
		{"binding participant", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.update(func(b *port.TaskBinding) { b.ParticipantID = "other" }) }},
		{"participant revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", func(f fixture) { f.access.RevokeParticipant("main") }},
		{"approval revoke", "COMPUTER_APPROVAL_NOT_FOUND", func(f fixture) { f.access.RevokeApproval("computer") }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) { a := f.ceiling.Approval.Clone(); a.Generation++; f.access.PutApproval(a) }},
		{"owner", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) { a := f.ceiling.Approval.Clone(); a.OwnerID = "other"; f.access.PutApproval(a) }},
		{"root", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) { a := f.ceiling.Approval.Clone(); a.Workspaces[0].Root = "/"; f.access.PutApproval(a) }},
		{"root inode", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.Workspaces[0].RootIdentity.Inode = "other"
			f.access.PutApproval(a)
		}},
		{"additional root", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.Workspaces = append(a.Workspaces, authority.ApprovedWorkspace{WorkspaceID: "other", Root: "/other", Access: authority.ReadAccess})
			f.access.PutApproval(a)
		}},
		{"exclusion", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
			f.access.PutApproval(a)
		}},
		{"capability", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) { a := f.ceiling.Approval.Clone(); a.Capabilities = nil; f.access.PutApproval(a) }},
		{"network", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.Network = authority.ApprovedNetwork
			f.access.PutApproval(a)
		}},
		{"commands", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.Commands = authority.NoCommands
			f.access.PutApproval(a)
		}},
		{"lineage", "AUTHORITY_TASK_MISMATCH", func(f fixture) {
			p := f.ceiling.Participant.Clone()
			p.ParentParticipantID = "other"
			f.access.PutParticipant(p)
		}},
		{"authority replacement", "AUTHORITY_TASK_MISMATCH", func(f fixture) {
			p := f.ceiling.Participant.Clone()
			p.Grant.AuthorityID = "other"
			f.access.PutParticipant(p)
		}},
		{"participant ceiling", "AUTHORITY_TASK_MISMATCH", func(f fixture) {
			p := f.ceiling.Participant.Clone()
			p.Grant.Workspaces[0].Root = "/"
			f.access.PutParticipant(p)
		}},
		{"participant exclusion", "AUTHORITY_TASK_MISMATCH", func(f fixture) {
			p := f.ceiling.Participant.Clone()
			p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private", RestrictionSource: authority.OwnerRestrictionSource}}
			f.access.PutParticipant(p)
		}},
	}
	for _, test := range changes {
		for _, after := range []bool{false, true} {
			t.Run(test.name+map[bool]string{false: " before", true: " after"}[after], func(t *testing.T) {
				f := newFixture(t)
				var l *executionsvc.Lease
				if after {
					l = lease(t, f, authority.Read)
				}
				test.change(f)
				if after {
					refused(t, observe(l), test.code)
				} else {
					out, err := f.service.Admit(context.Background(), authority.Read)
					// A trusted new turn can admit new work; it cannot extend the old lease.
					if test.name == "turn changed" {
						if out == nil || err != nil {
							t.Fatal(err)
						}
						return
					}
					if out != nil {
						t.Fatal("refused lease issued")
					}
					refused(t, err, test.code)
				}
			})
		}
	}
}
func TestOwnerTimeRenewalNeverExtendsFixedDeadline(t *testing.T) {
	f := newFixture(t)
	a := f.ceiling.Approval.Clone()
	a.ExpiresAt = f.clock.Now().Add(5 * time.Second)
	f.access.PutApproval(a)
	l := lease(t, f, authority.Read)
	deadline := l.Deadline()
	f.clock.advance(time.Second)
	f.access.PutApproval(f.ceiling.Approval)
	if !lease(t, f, authority.Read).Deadline().After(deadline) {
		t.Fatal("current owner time not used")
	}
	f.clock.advance(4 * time.Second)
	refused(t, observe(l), "AUTHORITY_EXPIRED")
	a.ExpiresAt = f.clock.Now().Add(-time.Millisecond)
	f.access.PutApproval(a)
	out, err := f.service.Admit(context.Background(), authority.Read)
	if out != nil {
		t.Fatal("owner expiry ignored")
	}
	refused(t, err, "AUTHORITY_EXPIRED")
}
func TestSnapshotsAndCeilingInputsCannotMutateLease(t *testing.T) {
	f := newFixture(t)
	l := lease(t, f, authority.Read)
	f.ceiling.Participant.Grant.Workspaces[0].Root = "/other"
	f.ceiling.Approval.Workspaces[0].Root = "/other"
	p := l.Participant()
	p.Grant.Capabilities[0] = authority.Write
	if err := l.WithSnapshot(context.Background(), "main", func(v port.AccessSnapshot) error {
		v.Participant.Grant.Workspaces[0].Root = "/other"
		v.Approval.Workspaces[0].Root = "/other"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := observe(l); err != nil {
		t.Fatal(err)
	}
	if l.Participant().Grant.Workspaces[0].Root != "/work" || l.Participant().Grant.Capabilities[0] != authority.Read {
		t.Fatal("lease aliased")
	}
}

type native struct {
	hook  func()
	reads int
}

func (n *native) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.reads++
	if n.hook != nil {
		n.hook()
	}
	return &port.ReadResponse{Text: "fixture", Bytes: 7}, nil
}
func (n *native) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	return &port.ListResponse{Entries: []string{"README.md"}}, nil
}
func request(f fixture) workspacesvc.ReadRequest {
	g := f.ceiling.Participant.Grant
	return workspacesvc.ReadRequest{OwnerID: g.OwnerID, SessionID: g.SessionID, TaskID: g.TaskID, TaskEpoch: g.TaskEpoch, ParticipantID: "main", TurnID: "body correlation", Generation: 99, CallID: "call", WorkspaceID: "work", RelativePath: "README.md"}
}
func TestExistingReadUsesOneLeaseAcrossAdmissionIOAndDisclosure(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(fixture)
	}{
		{"outer expiry", "", func(f fixture) { f.clock.advance(2 * time.Second) }},
		{"lease deadline", "AUTHORITY_EXPIRED", func(f fixture) { f.clock.advance(15 * time.Second) }},
		{"trusted turn", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.update(func(b *port.TaskBinding) { b.TurnID = "new" }) }},
		{"revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", func(f fixture) { f.access.RevokeParticipant("main") }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) { a := f.ceiling.Approval.Clone(); a.Generation++; f.access.PutApproval(a) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			l := lease(t, f, authority.Read)
			n := &native{hook: func() { test.change(f) }}
			s := workspacesvc.New(l, n, f.clock)
			out, err := s.Read(context.Background(), request(f))
			if n.reads != 1 {
				t.Fatal("read replayed")
			}
			if test.code == "" {
				if out == nil || err != nil {
					t.Fatal(err)
				}
			} else {
				if out != nil {
					t.Fatal("disclosed refused bytes")
				}
				refused(t, err, test.code)
			}
		})
	}
}
func TestMissingDepsAndProofRefuseWithoutIO(t *testing.T) {
	f := newFixture(t)
	for _, makeService := range []func() (*executionsvc.Service, error){func() (*executionsvc.Service, error) { return executionsvc.New(nil, f.tasks, f.clock, f.ceiling) }, func() (*executionsvc.Service, error) { return executionsvc.New(f.access, nil, f.clock, f.ceiling) }, func() (*executionsvc.Service, error) { return executionsvc.New(f.access, f.tasks, nil, f.ceiling) }} {
		s, err := makeService()
		if s != nil {
			t.Fatal("missing dependency admitted")
		}
		refused(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	}
	f.tasks.binding = nil
	out, err := f.service.Admit(context.Background(), authority.Read)
	if out != nil {
		t.Fatal("body-only admission")
	}
	refused(t, err, "AUTHORITY_TASK_MISMATCH")
	var l *executionsvc.Lease
	refused(t, l.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { return nil }), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
}
func TestCancelledOrExpiredBeforeNativeIOIsNotReminted(t *testing.T) {
	f := newFixture(t)
	l := lease(t, f, authority.Read)
	f.clock.advance(15 * time.Second)
	n := &native{}
	s := workspacesvc.New(l, n, f.clock)
	out, err := s.Read(context.Background(), request(f))
	if out != nil || n.reads != 0 {
		t.Fatal("expired lease dispatched/reminted")
	}
	refused(t, err, "AUTHORITY_EXPIRED")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out2, err := f.service.Admit(ctx, authority.Read)
	if out2 != nil {
		t.Fatal("cancelled lease")
	}
	refused(t, err, "WORKSPACE_REQUEST_CANCELLED")
}

type taskFunc func(context.Context, func(*port.TaskBinding) error) error

func (f taskFunc) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	return f(ctx, inspect)
}

type accessFunc func(context.Context, string, func(port.AccessSnapshot) error) error

func (f accessFunc) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	return f(ctx, id, inspect)
}
func TestUnavailableOrBrokenOwnerCallbackCannotIssueOrDisclose(t *testing.T) {
	for _, test := range []struct {
		name  string
		tasks func(fixture) port.CurrentTaskAdmission
		repo  func(fixture) port.AccessRepository
		code  string
	}{
		{"task silent", func(f fixture) port.CurrentTaskAdmission {
			return taskFunc(func(context.Context, func(*port.TaskBinding) error) error { return nil })
		}, nil, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"},
		{"task double", func(f fixture) port.CurrentTaskAdmission {
			return taskFunc(func(ctx context.Context, cb func(*port.TaskBinding) error) error {
				_ = cb(f.tasks.binding)
				_ = cb(f.tasks.binding)
				return nil
			})
		}, nil, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"},
		{"task missing swallowed", func(f fixture) port.CurrentTaskAdmission {
			return taskFunc(func(ctx context.Context, cb func(*port.TaskBinding) error) error { _ = cb(nil); return nil })
		}, nil, "AUTHORITY_TASK_MISMATCH"},
		{"access silent", nil, func(f fixture) port.AccessRepository {
			return accessFunc(func(context.Context, string, func(port.AccessSnapshot) error) error { return nil })
		}, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"},
		{"access double", nil, func(f fixture) port.AccessRepository {
			return accessFunc(func(ctx context.Context, id string, cb func(port.AccessSnapshot) error) error {
				_ = f.access.WithSnapshot(ctx, id, cb)
				_ = f.access.WithSnapshot(ctx, id, cb)
				return nil
			})
		}, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"},
		{"access missing swallowed", nil, func(f fixture) port.AccessRepository {
			return accessFunc(func(ctx context.Context, id string, cb func(port.AccessSnapshot) error) error {
				_ = cb(port.AccessSnapshot{})
				return nil
			})
		}, "COMPUTER_PARTICIPANT_NOT_FOUND"},
		{"access unavailable", nil, func(f fixture) port.AccessRepository {
			return accessFunc(func(context.Context, string, func(port.AccessSnapshot) error) error { return errors.New("private") })
		}, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			var tasks port.CurrentTaskAdmission = f.tasks
			var repo port.AccessRepository = f.access
			if test.tasks != nil {
				tasks = test.tasks(f)
			}
			if test.repo != nil {
				repo = test.repo(f)
			}
			s, err := executionsvc.New(repo, tasks, f.clock, f.ceiling)
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Admit(context.Background(), authority.Read)
			if out != nil {
				t.Fatal("broken owner issued lease")
			}
			refused(t, err, test.code)
		})
	}
}
func TestDisclosureCallbackSerializesBothCurrentOwners(t *testing.T) {
	f := newFixture(t)
	l := lease(t, f, authority.Read)
	entered, release := make(chan struct{}), make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- l.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { close(entered); <-release; return nil })
	}()
	<-entered
	taskStarted, taskDone, accessStarted, accessDone := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		close(taskStarted)
		f.tasks.update(func(b *port.TaskBinding) { b.TurnID = "new" })
		close(taskDone)
	}()
	go func() { close(accessStarted); f.access.RevokeParticipant("main"); close(accessDone) }()
	<-taskStarted
	<-accessStarted
	select {
	case <-taskDone:
		t.Fatal("task changed during disclosure")
	case <-accessDone:
		t.Fatal("authority changed during disclosure")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	<-taskDone
	<-accessDone
	refused(t, observe(l), "COMPUTER_PARTICIPANT_NOT_FOUND")
}
func TestChangedOwnerExpiryRefusesBeforeFixedDeadline(t *testing.T) {
	f := newFixture(t)
	l := lease(t, f, authority.Read)
	a := f.ceiling.Approval.Clone()
	a.ExpiresAt = f.clock.Now().Add(time.Second)
	f.access.PutApproval(a)
	f.clock.advance(2 * time.Second)
	refused(t, observe(l), "AUTHORITY_EXPIRED")
	if !l.Deadline().Equal(time.UnixMilli(1700000015000)) {
		t.Fatal("current owner changed fixed lease")
	}
}

func TestProposedAccessBeforeTaskOrderQualifiesBeforeTaskGate(t *testing.T) {
	f := newFixture(t)
	accessCallback, taskCallback := false, false
	repo := accessFunc(func(ctx context.Context, id string, cb func(port.AccessSnapshot) error) error {
		if taskCallback {
			t.Fatal("native access qualification under task gate")
		}
		return f.access.WithSnapshot(ctx, id, func(v port.AccessSnapshot) error {
			accessCallback = true
			defer func() { accessCallback = false }()
			return cb(v)
		})
	})
	tasks := taskFunc(func(ctx context.Context, cb func(*port.TaskBinding) error) error {
		if !accessCallback {
			t.Fatal("task callback acquired before access snapshot")
		}
		taskCallback = true
		defer func() { taskCallback = false }()
		return f.tasks.WithCurrent(ctx, cb)
	})
	s, err := executionsvc.New(repo, tasks, f.clock, f.ceiling)
	if err != nil {
		t.Fatal(err)
	}
	l, err := s.Admit(context.Background(), authority.Read)
	if err != nil {
		t.Fatal(err)
	}
	err = l.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error {
		if !accessCallback || !taskCallback {
			t.Fatal("owners released before disclosure")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

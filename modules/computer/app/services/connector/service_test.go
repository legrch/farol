package connector_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Offline policy fixtures only. No native filesystem, host, process, transport,
// authentication, app, provider or actual connector lifecycle is exercised.
var ctx = context.Background()

type clock struct{ ms atomic.Int64 }

func (c *clock) Now() time.Time          { return time.UnixMilli(c.ms.Load()) }
func (c *clock) advance(d time.Duration) { c.ms.Add(d.Milliseconds()) }

type guard struct {
	gate    sync.Mutex
	host    port.ConnectorHost
	current bool
	err     error
	check   func()
}

func (g *guard) WithConnectorCurrent(_ context.Context, host port.ConnectorHost, cb func(bool) error) error {
	g.gate.Lock()
	defer g.gate.Unlock()
	if g.check != nil {
		g.check()
	}
	if g.err != nil {
		return g.err
	}
	return cb(g.current && host == g.host)
}
func (g *guard) change(fn func(*guard)) { g.gate.Lock(); defer g.gate.Unlock(); fn(g) }

type journal struct {
	gate                      sync.Mutex
	clock                     *clock
	approval                  authority.Approval
	p                         *authority.Participant
	revoked                   bool
	revision                  uint64
	publishes, withdrawals    atomic.Int64
	publishHook, withdrawHook func()
	publishErr, withdrawErr   error
	changeResult              func(*port.ConnectorPublication)
	inSnapshot                atomic.Bool
}

func (j *journal) WithSnapshot(_ context.Context, id string, cb func(port.AccessSnapshot) error) error {
	j.gate.Lock()
	defer j.gate.Unlock()
	j.inSnapshot.Store(true)
	defer j.inSnapshot.Store(false)
	v := port.AccessSnapshot{}
	if j.p != nil && !j.revoked && id == j.p.ParticipantID {
		p, a := j.p.Clone(), j.approval.Clone()
		v.Participant, v.Approval = &p, &a
	}
	return cb(v)
}
func (j *journal) PublishConnector(_ context.Context, v port.ConnectorLaunch) (port.ConnectorPublication, error) {
	j.publishes.Add(1)
	if j.publishHook != nil {
		j.publishHook()
	}
	j.gate.Lock()
	defer j.gate.Unlock()
	if j.p != nil || j.revoked {
		return port.ConnectorPublication{}, errors.New("fixture duplicate/conflict")
	}
	g, err := authority.Derive(j.approval, v.Admission, j.clock.Now())
	if err != nil {
		return port.ConnectorPublication{}, err
	}
	p, err := authority.Create(*g, v.Participant)
	if err != nil {
		return port.ConnectorPublication{}, err
	}
	j.p = p
	j.revision++
	result := port.ConnectorPublication{Revision: j.revision, OriginalPublished: true, Participant: p.Clone(), Approval: j.approval.Clone()}
	if j.changeResult != nil {
		j.changeResult(&result)
	}
	return result, j.publishErr
}
func (j *journal) WithdrawConnector(_ context.Context, _ string) error {
	j.withdrawals.Add(1)
	if j.withdrawHook != nil {
		j.withdrawHook()
	}
	j.gate.Lock()
	defer j.gate.Unlock()
	if j.withdrawErr != nil {
		return j.withdrawErr
	}
	if j.p == nil {
		return errors.New("fixture participant absent")
	}
	j.revoked = true
	j.revision++
	return nil
}
func (j *journal) change(fn func(*journal)) { j.gate.Lock(); defer j.gate.Unlock(); fn(j) }

type fixture struct {
	root    *rootFixture
	owner   *connector.Service
	journal *journal
	guard   *guard
	clock   *clock
	launch  port.ConnectorLaunch
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	c := &clock{}
	c.ms.Store(1700000000000)
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3,
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}},
		Capabilities: []authority.Capability{authority.Read, authority.List, authority.Write, authority.Shell}, Network: authority.NoNetwork, Commands: authority.WorkspaceCommands, ExpiresAt: c.Now().Add(time.Hour)}
	l := port.ConnectorLaunch{Host: port.ConnectorHost{ProfileID: "profile", BackendGeneration: "backend", BuildID: "build", RuntimeID: "runtime", LaunchDigest: "digest", ConnectorGeneration: 7},
		Admission: authority.Admission{Identity: authority.Identity{OwnerID: "owner", SessionID: "root-session", TaskID: "root-work-scope", TaskEpoch: 11}, AuthorityID: "root-authority", ComputerID: a.ComputerID, ComputerGeneration: a.Generation,
			Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess, Paths: []string{"README.md"}}}, Capabilities: append([]authority.Capability(nil), a.Capabilities...), Network: a.Network, Commands: a.Commands, ExpiresAt: c.Now().Add(time.Second)}},
		Participant: authority.ParticipantAdmission{ParticipantID: "root-participant", Role: authority.Main, MutationOwnership: authority.TaskOwnership}, TurnCorrelation: "root-correlation", Approval: a}
	j := &journal{clock: c, approval: a.Clone(), revision: 1}
	g := &guard{host: l.Host, current: true}
	s, err := connector.New(&sync.Mutex{}, j, g, c, l)
	if err != nil {
		t.Fatal(err)
	}
	return fixture{root: &rootFixture{owner: s, journal: j, clock: c}, owner: s, journal: j, guard: g, clock: c, launch: l}
}
func refused(t *testing.T, err error) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Retry != "never" {
		t.Fatalf("want classified no-retry failure, got %v", err)
	}
}

// This fixture models trusted-root composition only. The connector production
// service owns neither this issuer nor sibling application-service dependencies.
type rootFixture struct {
	owner   *connector.Service
	journal port.ConnectorJournal
	clock   port.Clock
	issuer  *execution.Service
	binding port.TaskBinding
}

func (r *rootFixture) compose(t *testing.T) {
	t.Helper()
	if r.issuer != nil {
		t.Fatal("root attempted to replace retained issuer")
	}
	ceiling, err := r.owner.ExecutionCeiling(ctx)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := r.owner.Reconnect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r.binding = *binding
	r.issuer, err = execution.New(r.journal, r.owner, r.clock, execution.Ceiling{Participant: ceiling.Participant, Approval: ceiling.Approval})
	if err != nil {
		t.Fatal(err)
	}
}

func (r *rootFixture) reconnect() (*execution.Service, error) {
	binding, err := r.owner.Reconnect(ctx)
	if err != nil {
		return nil, err
	}
	if r.issuer == nil || *binding != r.binding {
		return nil, errors.New("fixture root admission mismatch")
	}
	return r.issuer, nil
}

func publish(t *testing.T, f fixture) *execution.Service {
	t.Helper()
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	f.root.compose(t)
	s, err := f.root.reconnect()
	if err != nil || s == nil {
		t.Fatal(err)
	}
	return s
}
func lease(t *testing.T, s *execution.Service) *execution.Lease {
	t.Helper()
	l, err := s.Admit(ctx, authority.Read)
	if err != nil || l == nil {
		t.Fatal(err)
	}
	return l
}
func observe(l *execution.Lease) error {
	return l.WithSnapshot(ctx, l.Binding().ParticipantID, func(port.AccessSnapshot) error { return nil })
}

func TestPendingPublicationExactlyOnceAndSameOwnerReconnect(t *testing.T) {
	f := newFixture(t)
	calls := 0
	if err := f.owner.WithCurrent(ctx, func(b *port.TaskBinding) error {
		calls++
		if b != nil {
			t.Fatal("pending positive")
		}
		return nil
	}); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	_, err := f.owner.Reconnect(ctx)
	refused(t, err)
	entered, release := make(chan struct{}), make(chan struct{})
	f.journal.publishHook = func() { close(entered); <-release }
	done := make(chan error, 1)
	go func() { done <- f.owner.Publish(ctx) }()
	<-entered
	refused(t, f.owner.Publish(ctx))
	if err := f.owner.WithCurrent(ctx, func(b *port.TaskBinding) error {
		if b != nil {
			t.Fatal("publishing positive")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	f.root.compose(t)
	s, err := f.root.reconnect()
	if err != nil {
		t.Fatal(err)
	}
	s2, err := f.root.reconnect()
	if err != nil || s != s2 {
		t.Fatal("issuer replaced", err)
	}
	refused(t, f.owner.Publish(ctx))
	if f.journal.publishes.Load() != 1 {
		t.Fatal("publication replay")
	}
	b := lease(t, s).Binding()
	if b.SessionID != "root-session" || b.TaskID != "root-work-scope" || b.TaskEpoch != 11 || b.TurnID != "root-correlation" {
		t.Fatal("root correlation changed", b)
	}
	if err := f.owner.WithCurrent(ctx, func(b *port.TaskBinding) error { b.TurnID = "provider-turn"; return nil }); err != nil {
		t.Fatal(err)
	}
	if lease(t, s).Binding() != b {
		t.Fatal("binding aliased")
	}
}

func TestErrorLostReplyAndInvalidReadbackNeverActivateOrReplay(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*journal)
	}{
		{"lost reply after commit", func(j *journal) { j.publishErr = errors.New("lost ACK") }},
		{"known error", func(j *journal) { j.publishErr = authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "fixture") }},
		{"not original", func(j *journal) { j.changeResult = func(v *port.ConnectorPublication) { v.OriginalPublished = false } }},
		{"unknown revision", func(j *journal) { j.changeResult = func(v *port.ConnectorPublication) { v.Revision = 0 } }},
		{"conflicting identity", func(j *journal) {
			j.changeResult = func(v *port.ConnectorPublication) { v.Participant.Grant.TaskEpoch++ }
		}},
		{"conflicting scope", func(j *journal) {
			j.changeResult = func(v *port.ConnectorPublication) { v.Participant.Grant.Workspaces[0].Root = "/" }
		}},
		{"conflicting policy", func(j *journal) { j.changeResult = func(v *port.ConnectorPublication) { v.Approval.Generation++ } }},
		{"changed original expiry", func(j *journal) {
			j.changeResult = func(v *port.ConnectorPublication) {
				v.Participant.Grant.ExpiresAt = v.Participant.Grant.ExpiresAt.Add(time.Second)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			test.change(f.journal)
			refused(t, f.owner.Publish(ctx))
			refused(t, f.owner.Publish(ctx))
			_, err := f.owner.Reconnect(ctx)
			refused(t, err)
			if f.journal.publishes.Load() != 1 {
				t.Fatal("unknown replayed")
			}
		})
	}
}

func TestReconstructedOwnerDoesNotRestorePersistedLiveness(t *testing.T) {
	for _, conflict := range []bool{false, true} {
		f := newFixture(t)
		publish(t, f)
		l := f.launch
		if conflict {
			l.Admission.TaskEpoch++
		}
		other, err := connector.New(&sync.Mutex{}, f.journal, f.guard, f.clock, l)
		if err != nil {
			t.Fatal(err)
		}
		_, err = other.Reconnect(ctx)
		refused(t, err)
		refused(t, other.Publish(ctx))
		_, err = other.Reconnect(ctx)
		refused(t, err)
	}
}

func TestWithdrawalNegativeBeforePersistenceAndLateCommitStaysUnavailable(t *testing.T) {
	f := newFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	f.journal.publishHook = func() { close(entered); <-release }
	done := make(chan error, 1)
	go func() { done <- f.owner.Publish(ctx) }()
	<-entered
	f.journal.withdrawHook = func() {
		_, err := f.owner.Reconnect(ctx)
		refused(t, err) // No owner gate held by journal call.
	}
	refused(t, f.owner.Withdraw(ctx)) // Publication has not yet reached the journal.
	close(release)
	refused(t, <-done)
	if f.journal.p == nil {
		t.Fatal("fixture did not model late commit")
	}
	_, err := f.owner.Reconnect(ctx)
	refused(t, err)
	refused(t, f.owner.Publish(ctx))
	refused(t, f.owner.Withdraw(ctx))
	if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 1 {
		t.Fatal("late commit replayed")
	}
}

func TestWithdrawalFailureAndRevokedParticipantRefuseExistingLease(t *testing.T) {
	for _, failed := range []bool{false, true} {
		f := newFixture(t)
		l := lease(t, publish(t, f))
		f.journal.withdrawHook = func() { refused(t, observe(l)) } // Negative before store IO; no lock inversion.
		if failed {
			f.journal.withdrawErr = errors.New("withdraw lost ACK")
		}
		err := f.owner.Withdraw(ctx)
		if failed {
			refused(t, err)
		} else if err != nil {
			t.Fatal(err)
		}
		refused(t, observe(l))
		_, err = f.owner.Reconnect(ctx)
		refused(t, err)
		if f.journal.withdrawals.Load() != 1 {
			t.Fatal("revocation replay")
		}
	}
	f := newFixture(t)
	s := publish(t, f)
	l := lease(t, s)
	f.journal.change(func(j *journal) { j.revoked = true })
	refused(t, observe(l))
	_, err := s.Admit(ctx, authority.Read)
	refused(t, err)
}

func TestHostAndSettingsFenceCannotRecoverSameOwner(t *testing.T) {
	changes := []func(*guard){
		func(g *guard) { g.host.ProfileID += "-other" }, func(g *guard) { g.host.BackendGeneration += "-other" },
		func(g *guard) { g.host.BuildID += "-other" }, func(g *guard) { g.host.RuntimeID += "-other" },
		func(g *guard) { g.host.LaunchDigest += "-other" }, func(g *guard) { g.host.ConnectorGeneration++ },
		func(g *guard) { g.current = false }, func(g *guard) { g.err = errors.New("settings fence unavailable") },
	}
	for i, change := range changes {
		t.Run(time.Duration(i).String(), func(t *testing.T) {
			f := newFixture(t)
			s := publish(t, f)
			l := lease(t, s)
			f.guard.change(change)
			refused(t, observe(l))
			f.guard.change(func(g *guard) { g.host = f.launch.Host; g.current = true; g.err = nil })
			_, err := f.owner.Reconnect(ctx)
			refused(t, err)
			refused(t, observe(l))
		})
	}
}

func TestImmutableSealAndTimeOnlyRenewalUseExistingLease(t *testing.T) {
	f := newFixture(t)
	f.launch.Admission.Workspaces[0].Paths[0] = "untrusted"
	f.launch.Approval.Workspaces[0].Root = "/"
	s := publish(t, f)
	old := lease(t, s)
	deadline := old.Deadline()
	original := old.Participant()
	f.clock.advance(2 * time.Second) // Original persisted participant has expired.
	f.journal.change(func(j *journal) { j.approval.ExpiresAt = j.approval.ExpiresAt.Add(time.Hour) })
	s2, err := f.root.reconnect()
	if err != nil || s != s2 {
		t.Fatal(err)
	}
	next := lease(t, s2)
	if !next.Deadline().After(deadline) || !old.Deadline().Equal(deadline) || !authority.SameParticipantCeiling(next.Participant(), original) {
		t.Fatal("lease seal/deadline changed")
	}
	if err := observe(old); err != nil {
		t.Fatal(err)
	}
	f.journal.change(func(j *journal) {
		if !j.p.Grant.ExpiresAt.Equal(time.UnixMilli(1700000001000)) {
			t.Fatal("journal renewed")
		}
	})
	if !reflect.DeepEqual(next.Participant().Grant.Workspaces[0].Paths, []string{"README.md"}) {
		t.Fatal("constructor aliased scope")
	}
	f.clock.advance(13 * time.Second)
	refused(t, observe(old))
	f.journal.change(func(j *journal) { j.approval.Workspaces[0].Root = "/" })
	_, err = s.Admit(ctx, authority.Read)
	refused(t, err)
	refused(t, observe(next))
}

type reader struct {
	hook  func()
	reads int
}

func (r *reader) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	r.reads++
	if r.hook != nil {
		r.hook()
	}
	return &port.ReadResponse{Text: "fixture secret", Bytes: 14}, nil
}
func (*reader) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	return nil, errors.New("unused fixture")
}
func TestFinalDisclosureUsesOneExistingExecutionLease(t *testing.T) {
	for _, fence := range []bool{false, true} {
		f := newFixture(t)
		l := lease(t, publish(t, f))
		b := l.Binding()
		r := &reader{hook: func() {
			if fence {
				f.guard.change(func(g *guard) { g.current = false })
			} else if err := f.owner.Withdraw(ctx); err != nil {
				t.Fatal(err)
			}
		}}
		w := workspace.New(l, r, f.clock)
		out, err := w.Read(ctx, workspace.ReadRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: "provider-body-is-only-correlation", WorkspaceID: "work", RelativePath: "README.md"})
		if out != nil || r.reads != 1 {
			t.Fatal("refused bytes disclosed or IO replayed")
		}
		refused(t, err)
	}
}

func TestAccessBeforeOwnerGateAndDisclosureSerializesWithdrawal(t *testing.T) {
	f := newFixture(t)
	l := lease(t, publish(t, f))
	f.guard.change(func(g *guard) {
		g.check = func() {
			if !f.journal.inSnapshot.Load() {
				t.Error("owner entered before access snapshot")
			}
		}
	})
	entered, release := make(chan struct{}), make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- l.WithSnapshot(ctx, l.Binding().ParticipantID, func(port.AccessSnapshot) error { close(entered); <-release; return nil })
	}()
	<-entered
	started, done := make(chan struct{}), make(chan error, 1)
	go func() { close(started); done <- f.owner.Withdraw(ctx) }()
	<-started
	select {
	case err := <-done:
		t.Fatal("withdrawal crossed disclosure", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	refused(t, observe(l))
}

func TestMissingGuardAndCancelledPublicationFailClosed(t *testing.T) {
	f := newFixture(t)
	for _, makeOwner := range []func() (*connector.Service, error){
		func() (*connector.Service, error) { return connector.New(nil, f.journal, f.guard, f.clock, f.launch) },
		func() (*connector.Service, error) {
			return connector.New(&sync.Mutex{}, nil, f.guard, f.clock, f.launch)
		},
		func() (*connector.Service, error) {
			return connector.New(&sync.Mutex{}, f.journal, nil, f.clock, f.launch)
		},
		func() (*connector.Service, error) {
			return connector.New(&sync.Mutex{}, f.journal, f.guard, nil, f.launch)
		},
	} {
		s, err := makeOwner()
		if s != nil {
			t.Fatal("missing dependency accepted")
		}
		refused(t, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	refused(t, f.owner.Publish(cancelled))
	refused(t, f.owner.Publish(ctx))
	if f.journal.publishes.Load() != 0 {
		t.Fatal("cancelled dispatch")
	}
}

type guardFunc func(context.Context, port.ConnectorHost, func(bool) error) error

func (f guardFunc) WithConnectorCurrent(c context.Context, h port.ConnectorHost, cb func(bool) error) error {
	return f(c, h, cb)
}

func TestBrokenGuardCallbacksFailClosedWithoutDuplicateInspection(t *testing.T) {
	for _, kind := range []string{"silent", "double", "swallowed", "error after callback"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			var broken atomic.Bool
			g := guardFunc(func(_ context.Context, _ port.ConnectorHost, cb func(bool) error) error {
				if !broken.Load() {
					return cb(true)
				}
				switch kind {
				case "silent":
					return nil
				case "double":
					_ = cb(true)
					_ = cb(true)
					return nil
				case "swallowed":
					_ = cb(false)
					return nil
				default:
					_ = cb(true)
					return errors.New("guard failed after callback")
				}
			})
			s, err := connector.New(&sync.Mutex{}, f.journal, g, f.clock, f.launch)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Publish(ctx); err != nil {
				t.Fatal(err)
			}
			broken.Store(true)
			calls := 0
			refused(t, s.WithCurrent(ctx, func(*port.TaskBinding) error { calls++; return nil }))
			if calls > 1 {
				t.Fatal("consumer inspected twice")
			}
			broken.Store(false)
			_, err = s.Reconnect(ctx)
			refused(t, err)
		})
	}
}

func TestGuardFenceDuringPublicationCannotActivate(t *testing.T) {
	f := newFixture(t)
	f.journal.publishHook = func() { f.guard.change(func(g *guard) { g.current = false }) }
	refused(t, f.owner.Publish(ctx))
	f.guard.change(func(g *guard) { g.current = true })
	_, err := f.owner.Reconnect(ctx)
	refused(t, err)
	refused(t, f.owner.Publish(ctx))
	if f.journal.publishes.Load() != 1 {
		t.Fatal("stale host replayed")
	}

	f = newFixture(t)
	f.guard.change(func(g *guard) { g.current = false })
	refused(t, f.owner.Publish(ctx))
	if f.journal.publishes.Load() != 0 {
		t.Fatal("stale host published")
	}
}

func TestConsumerRefusalDoesNotWithdrawCurrentOwner(t *testing.T) {
	f := newFixture(t)
	s := publish(t, f)
	_, err := s.Admit(ctx, authority.NetworkUse)
	refused(t, err)
	if err := observe(lease(t, s)); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("consumer result")
	if err := f.owner.WithCurrent(ctx, func(*port.TaskBinding) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatal("consumer error lost", err)
	}
	if _, err := f.owner.Reconnect(ctx); err != nil {
		t.Fatal("consumer refusal withdrew owner", err)
	}
}

func TestConcurrentPublicationHasOneOriginalAttempt(t *testing.T) {
	f := newFixture(t)
	start := make(chan struct{})
	var wg sync.WaitGroup
	var known atomic.Int64
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if err := f.owner.Publish(ctx); err == nil {
				known.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if known.Load() != 1 || f.journal.publishes.Load() != 1 {
		t.Fatal("duplicate original", known.Load(), f.journal.publishes.Load())
	}
	if _, err := f.owner.Reconnect(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestExecutionCeilingRequiresPublicationAndReturnsIndependentValues(t *testing.T) {
	f := newFixture(t)
	if ceiling, err := f.owner.ExecutionCeiling(ctx); ceiling != nil || err == nil {
		t.Fatal("pending owner exported ceiling", err)
	}
	f.journal.publishHook = func() {
		if ceiling, err := f.owner.ExecutionCeiling(ctx); ceiling != nil || err == nil {
			t.Fatal("publishing owner exported ceiling", err)
		}
	}
	s := publish(t, f)
	original, err := f.owner.ExecutionCeiling(ctx)
	if err != nil {
		t.Fatal(err)
	}
	copy, err := f.owner.ExecutionCeiling(ctx)
	if err != nil {
		t.Fatal(err)
	}
	copy.Participant.Grant.Workspaces[0].Paths[0] = "other"
	copy.Participant.Grant.Capabilities[0] = authority.NetworkUse
	copy.Approval.Workspaces[0].Root = "/"
	copy.Approval.Capabilities[0] = authority.NetworkUse
	current, err := f.owner.ExecutionCeiling(ctx)
	if err != nil || !reflect.DeepEqual(original, current) {
		t.Fatal("exported ceiling mutated owner", err)
	}
	binding, err := f.owner.Reconnect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	binding.TaskID = "provider-thread"
	binding.TurnID = "provider-turn"
	retained, err := f.root.reconnect()
	if err != nil || retained != s {
		t.Fatal("reconnect replaced root issuer or aliased binding", err)
	}
	l := lease(t, retained)
	if !authority.SameParticipantCeiling(l.Participant(), original.Participant) {
		t.Fatal("exported ceiling mutated issuer")
	}
	if err := f.owner.Withdraw(ctx); err != nil {
		t.Fatal(err)
	}
	if ceiling, err := f.owner.ExecutionCeiling(ctx); ceiling != nil || err == nil {
		t.Fatal("withdrawn owner exported ceiling", err)
	}
	refused(t, observe(l))
}

type observedGate struct {
	mutex sync.Mutex
	held  atomic.Bool
}

func (g *observedGate) Lock()   { g.mutex.Lock(); g.held.Store(true) }
func (g *observedGate) Unlock() { g.held.Store(false); g.mutex.Unlock() }

func TestInjectedGateProtectsInspectionAndReleasesBeforeJournalCalls(t *testing.T) {
	f := newFixture(t)
	gate := &observedGate{}
	owner, err := connector.New(gate, f.journal, f.guard, f.clock, f.launch)
	if err != nil {
		t.Fatal(err)
	}
	f.guard.check = func() {
		if !gate.held.Load() {
			t.Fatal("guard entered outside injected gate")
		}
	}
	f.journal.publishHook = func() {
		if gate.held.Load() {
			t.Fatal("publication under owner gate")
		}
	}
	f.journal.withdrawHook = func() {
		if gate.held.Load() {
			t.Fatal("withdrawal persistence under owner gate")
		}
	}
	if err := owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if err := owner.WithCurrent(ctx, func(b *port.TaskBinding) error {
		calls++
		if b == nil || !gate.held.Load() {
			t.Fatal("inspection outside injected gate")
		}
		return nil
	}); err != nil || calls != 1 {
		t.Fatal("inspection count", calls, err)
	}
	if err := owner.Withdraw(ctx); err != nil {
		t.Fatal(err)
	}
	if gate.held.Load() {
		t.Fatal("injected gate left held")
	}
}

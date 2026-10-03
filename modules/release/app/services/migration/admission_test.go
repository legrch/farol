package migration

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

var bound = port.MigrationBinding{
	Operation:  "migration-operation",
	AlphaBuild: "accepted-alpha-build",
	Source:     port.MigrationObject{Device: "1", File: "2"},
}
var sourceRoots = port.MigrationRoots{Source: &bound.Source}

type guard struct {
	checks atomic.Int32
	err    error
}

func (g *guard) ReverifyMigration(context.Context, port.MigrationBinding, port.MigrationRoots) error {
	g.checks.Add(1)
	return g.err
}
func newOwner(t *testing.T, g port.MigrationGuard) *Service {
	t.Helper()
	s, err := New(bound, g, &sync.Mutex{})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestOneAtomicClaimAcrossConcurrentConsumers(t *testing.T) {
	s := newOwner(t, &guard{})
	start := make(chan struct{})
	var successes, unexpected atomic.Int32
	var wg sync.WaitGroup
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			switch s.ClaimMigration(context.Background(), bound) {
			case nil:
				successes.Add(1)
			case ClaimConsumed:
			default:
				unexpected.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if successes.Load() != 1 || unexpected.Load() != 0 {
		t.Fatalf("claims=%d unexpected=%d", successes.Load(), unexpected.Load())
	}
}
func TestClaimSurvivesLostAcknowledgmentAndOwnerClose(t *testing.T) {
	g := &guard{}
	s := newOwner(t, g)
	err := func() error {
		if err := s.ClaimMigration(context.Background(), bound); err != nil {
			return err
		}
		return context.DeadlineExceeded
	}()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	s.Close()
	if err := s.ClaimMigration(context.Background(), bound); err != ClaimConsumed {
		t.Fatal(err)
	}
	if err := s.ReverifyMigration(context.Background(), bound, sourceRoots); err != nil {
		t.Fatal(err)
	}
	if g.checks.Load() != 1 {
		t.Fatal(g.checks.Load())
	}
}
func TestCancelledAndCrossedClaimsCannotConsumeAcceptedOperation(t *testing.T) {
	s := newOwner(t, &guard{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.ClaimMigration(ctx, bound); err != CallerCancelled {
		t.Fatal(err)
	}
	for _, field := range []string{"operation", "alpha", "device", "file"} {
		crossed := bound
		switch field {
		case "operation":
			crossed.Operation += "-other"
		case "alpha":
			crossed.AlphaBuild += "-other"
		case "device":
			crossed.Source.Device = "3"
		case "file":
			crossed.Source.File = "4"
		}
		if err := s.ClaimMigration(context.Background(), crossed); err != BindingInvalid {
			t.Fatal(field, err)
		}
	}
	if err := s.ClaimMigration(context.Background(), bound); err != nil {
		t.Fatal(err)
	}
}
func TestCloseBeforeClaimDoesNotCreateOrReleaseAuthority(t *testing.T) {
	g := &guard{}
	s := newOwner(t, g)
	s.Close()
	s.Close()
	if err := s.ClaimMigration(context.Background(), bound); err != AdmissionClosed {
		t.Fatal(err)
	}
	if g.checks.Load() != 0 {
		t.Fatal("Close invoked guard")
	}
}
func TestUncertainGuardFencesAllConsumersWithoutObservationReplay(t *testing.T) {
	g := &guard{err: errors.New("private path and provider detail")}
	s := newOwner(t, g)
	for range 2 {
		if err := s.ReverifyMigration(context.Background(), bound, sourceRoots); err != AdmissionUnproven {
			t.Fatal(err)
		}
	}
	if err := s.ClaimMigration(context.Background(), bound); err != AdmissionUnproven {
		t.Fatal(err)
	}
	if g.checks.Load() != 1 {
		t.Fatal("replayed guard", g.checks.Load())
	}
}
func TestCancelledOrCrossedVerificationNeverInvokesGuard(t *testing.T) {
	g := &guard{}
	s := newOwner(t, g)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.ReverifyMigration(ctx, bound, sourceRoots); err != CallerCancelled {
		t.Fatal(err)
	}
	crossed := bound
	crossed.Operation += "-other"
	if err := s.ReverifyMigration(context.Background(), crossed, sourceRoots); err != BindingInvalid {
		t.Fatal(err)
	}
	if g.checks.Load() != 0 {
		t.Fatal(g.checks.Load())
	}
	if err := s.ClaimMigration(context.Background(), bound); err != nil {
		t.Fatal(err)
	}
}
func TestConstructorRejectsMalformedBindingsAndMissingGuard(t *testing.T) {
	cases := []port.MigrationBinding{{}, {Operation: bound.Operation, AlphaBuild: bound.AlphaBuild}}
	for _, field := range []string{"operation", "alpha", "device", "file"} {
		for _, value := range []string{"", "\x00", strings.Repeat("1", 129)} {
			b := bound
			switch field {
			case "operation":
				b.Operation = value
			case "alpha":
				b.AlphaBuild = value
			case "device":
				b.Source.Device = value
			case "file":
				b.Source.File = value
			}
			cases = append(cases, b)
		}
	}
	for _, b := range cases {
		if _, err := New(b, &guard{}, &sync.Mutex{}); err != BindingInvalid {
			t.Fatal(b, err)
		}
	}
	if _, err := New(bound, nil, &sync.Mutex{}); err != BindingInvalid {
		t.Fatal(err)
	}
	if _, err := New(bound, &guard{}, nil); err != BindingInvalid {
		t.Fatal(err)
	}
}

// This consumer fixture exercises claim ownership, not native rename/authority.
// Identity must run competing-consumer cases against its actual adapter.
type consumer struct{ admission port.MigrationAdmission }
type lease struct {
	admission        port.MigrationAdmission
	armed, attempted bool
}

func (c consumer) acquire(phase port.MigrationPhase) (*lease, error) {
	if err := c.admission.ReverifyMigration(context.Background(), bound, sourceRoots); err != nil {
		return nil, err
	}
	l := &lease{admission: c.admission}
	if phase == port.MigrationPrepared {
		if err := c.admission.ClaimMigration(context.Background(), bound); err != nil {
			return nil, err
		}
		l.armed = true
	}
	return l, nil
}
func (l *lease) move(phase port.MigrationPhase, attempts *int) port.MigrationMovement {
	if !l.armed || l.attempted || phase != port.MigrationDispatched {
		return port.MigrationNoEffect
	}
	l.attempted = true
	if err := l.admission.ReverifyMigration(context.Background(), bound, sourceRoots); err != nil {
		return port.MigrationNoEffect
	}
	(*attempts)++
	// A visible source after response loss never authorizes another dispatch.
	return port.MigrationUnknown
}
func (l *lease) close() { l.armed = false }
func TestSeparatePreparedConsumersCannotReplayUnknownRename(t *testing.T) {
	s := newOwner(t, &guard{})
	first, err := (consumer{s}).acquire(port.MigrationPrepared)
	if err != nil {
		t.Fatal(err)
	}
	second, err := (consumer{s}).acquire(port.MigrationPrepared)
	if err != ClaimConsumed || second != nil {
		t.Fatalf("second=%v err=%v", second, err)
	}
	attempts := 0
	if got := first.move(port.MigrationDispatched, &attempts); got != port.MigrationUnknown {
		t.Fatal(got)
	}
	first.close()
	observation, err := (consumer{s}).acquire(port.MigrationDispatched)
	if err != nil {
		t.Fatal(err)
	}
	if got := observation.move(port.MigrationDispatched, &attempts); got != port.MigrationNoEffect {
		t.Fatal(got)
	}
	if attempts != 1 {
		t.Fatal(attempts)
	}
	if err := s.ClaimMigration(context.Background(), bound); err != ClaimConsumed {
		t.Fatal(err)
	}
}
func TestObservationOnlyConsumersDoNotSpendClaim(t *testing.T) {
	s := newOwner(t, &guard{})
	for _, phase := range []port.MigrationPhase{port.MigrationDispatched, port.MigrationRelocated} {
		l, err := (consumer{s}).acquire(phase)
		if err != nil {
			t.Fatal(err)
		}
		attempts := 0
		if got := l.move(port.MigrationDispatched, &attempts); got != port.MigrationNoEffect || attempts != 0 {
			t.Fatal(got, attempts)
		}
		l.close()
	}
	// The actual durable owner must never regress Dispatched to Prepared.
	// This final assertion isolates whether observation consumed the claim.
	if err := s.ClaimMigration(context.Background(), bound); err != nil {
		t.Fatal(err)
	}
}

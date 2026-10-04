package accountapproval

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// All identities and clocks are synthetic; these tests attest pure policy only.
var testScope = port.AccountScope{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session"}

type testClock struct {
	now  uint64
	hook func()
}

func (c *testClock) NowMillis() uint64 {
	if c.hook != nil {
		c.hook()
	}
	return c.now
}

type testGate struct {
	sync.Mutex
	inside bool
}

func (g *testGate) Lock()   { g.Mutex.Lock(); g.inside = true }
func (g *testGate) Unlock() { g.inside = false; g.Mutex.Unlock() }

func observation() port.AccountObservation {
	return port.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("a", 64), ObservedAtMillis: 10000, ExpiresAtMillis: 20000}
}

func fixture(t *testing.T) (*Service, *testGate, *testClock) {
	t.Helper()
	gate, clock := &testGate{}, &testClock{now: 10000}
	s, err := New(testScope, gate, clock)
	if err != nil {
		t.Fatal(err)
	}
	return s, gate, clock
}

func approve(t *testing.T, s *Service, id string, revision uint64) *Grant {
	t.Helper()
	g, err := s.Approve(context.Background(), id, revision, observation())
	if err != nil || g == nil {
		t.Fatalf("approve: grant=%v error=%v", g != nil, err)
	}
	return g
}

func revision(t *testing.T, s *Service, want uint64) {
	t.Helper()
	got, err := s.Revision(context.Background())
	if err != nil || got != want {
		t.Fatalf("revision=%d error=%v want=%d", got, err, want)
	}
}

func refused(t *testing.T, g *Grant, ctx context.Context, scope port.AccountScope, id string, o port.AccountObservation, want error) {
	t.Helper()
	called := false
	err := g.WithCurrent(ctx, scope, id, o, func(port.AccountApproval) error { called = true; return nil })
	if err != want || called {
		t.Fatalf("refusal error=%v want=%v callback=%v", err, want, called)
	}
}

func accepted(t *testing.T, g *Grant, id string) port.AccountApproval {
	t.Helper()
	var value port.AccountApproval
	count := 0
	err := g.WithCurrent(context.Background(), testScope, id, observation(), func(v port.AccountApproval) error {
		count++
		value = v
		return nil
	})
	if err != nil || count != 1 {
		t.Fatalf("current error=%v callbacks=%d", err, count)
	}
	return value
}

func TestNewScopeAndDependencies(t *testing.T) {
	for _, bad := range []string{"", strings.Repeat("x", 121), "has space", "tab\t", "delete\x7f", "control\u0085", string([]byte{0xff})} {
		for field := 0; field < 4; field++ {
			scope := testScope
			fields := []*string{&scope.ProfileID, &scope.BackendGeneration, &scope.OwnerID, &scope.SessionID}
			*fields[field] = bad
			if s, err := New(scope, &testGate{}, &testClock{}); s != nil || err != Invalid {
				t.Fatalf("field=%d invalid scope admitted", field)
			}
		}
	}
	scope := testScope
	scope.OwnerID = strings.Repeat("é", 60) // 120 bytes, valid UTF-8.
	if _, err := New(scope, &testGate{}, &testClock{}); err != nil {
		t.Fatal(err)
	}
	if _, err := New(testScope, nil, &testClock{}); err != Invalid {
		t.Fatal(err)
	}
	if _, err := New(testScope, &testGate{}, nil); err != Invalid {
		t.Fatal(err)
	}
	s, _, _ := fixture(t)
	revision(t, s, 0)
	if got, err := s.Revoke(context.Background(), 0); got != 0 || err != nil {
		t.Fatal(got, err)
	}
	if _, err := s.Revoke(context.Background(), 1); err != Mismatch {
		t.Fatal(err)
	}
}

func TestMintedGrantOnlyAndIndependentProjection(t *testing.T) {
	s, gate, _ := fixture(t)
	g := approve(t, s, "selected", 0)
	var projection port.AccountApproval
	err := g.WithCurrent(context.Background(), testScope, "selected", observation(), func(v port.AccountApproval) error {
		if !gate.inside {
			t.Fatal("callback outside owner gate")
		}
		projection = v
		v.Scope.OwnerID, v.ApprovalID, v.Revision, v.PrincipalKey = "changed", "changed", 0, "changed"
		return nil
	})
	if err != nil || projection != (port.AccountApproval{Scope: testScope, ApprovalID: "selected", Revision: 1, PrincipalKey: observation().PrincipalKey}) {
		t.Fatal(projection, err)
	}
	accepted(t, g, "selected")
	refused(t, nil, context.Background(), testScope, "selected", observation(), Invalid)
	refused(t, &Grant{}, context.Background(), testScope, "selected", observation(), Invalid)
	// Reconstruction with knowledge of every DTO field and even the owner cannot
	// substitute for the exact privately retained mint. No unsafe/reflection used.
	refused(t, &Grant{owner: s, approval: projection}, context.Background(), testScope, "selected", observation(), Stale)
	copy := *g
	refused(t, &copy, context.Background(), testScope, "selected", observation(), Stale)
	other, _, _ := fixture(t)
	foreign := approve(t, other, "foreign", 0)
	refused(t, foreign, context.Background(), testScope, "selected", observation(), Mismatch)
	refused(t, &Grant{owner: other, approval: projection}, context.Background(), testScope, "selected", observation(), Stale)
	if err := g.WithCurrent(context.Background(), testScope, "selected", observation(), nil); err != Invalid {
		t.Fatal(err)
	}
}

func TestCurrentGrantNeverReturnsAfterReplacementOrRevoke(t *testing.T) {
	s, _, _ := fixture(t)
	old := approve(t, s, "first", 0)
	second := approve(t, s, "second", 1) // Explicit replacement, same principal.
	refused(t, old, context.Background(), testScope, "first", observation(), Stale)
	accepted(t, second, "second")
	if got, err := s.Revoke(context.Background(), 2); got != 3 || err != nil {
		t.Fatal(got, err)
	}
	third := approve(t, s, "third", 3) // Same principal returns after withdrawal.
	for _, old := range []*Grant{old, second} {
		refused(t, old, context.Background(), testScope, old.approval.ApprovalID, observation(), Stale)
	}
	accepted(t, third, "third")
	revision(t, s, 4)
}

func TestScopeAndSelectionAreIndependentlyRequired(t *testing.T) {
	s, _, _ := fixture(t)
	g := approve(t, s, "selected", 0)
	for field := 0; field < 4; field++ {
		scope := testScope
		fields := []*string{&scope.ProfileID, &scope.BackendGeneration, &scope.OwnerID, &scope.SessionID}
		*fields[field] += "-foreign"
		refused(t, g, context.Background(), scope, "selected", observation(), Mismatch)
	}
	refused(t, g, context.Background(), testScope, "another", observation(), Mismatch)
	refused(t, g, context.Background(), port.AccountScope{}, "selected", observation(), Invalid)
	refused(t, g, context.Background(), testScope, "", observation(), Invalid)
	accepted(t, g, "selected")
}

func TestFreshPrincipalEqualityAndNoImplicitRevocation(t *testing.T) {
	s, _, _ := fixture(t)
	g := approve(t, s, "selected", 0)
	for _, label := range []string{"provider-user-changed", "provider-account-changed"} {
		t.Run(label, func(t *testing.T) {
			o := observation()
			o.PrincipalKey = strings.Repeat("b", 64) // Hashing belongs to the observer.
			refused(t, g, context.Background(), testScope, "selected", o, Mismatch)
		})
	}
	o := observation()
	o.State = "unknown" // Populated old fields confer no authority.
	refused(t, g, context.Background(), testScope, "selected", o, Unavailable)
	accepted(t, g, "selected")
	revision(t, s, 1)
}

func TestInvalidAndStaleObservationsDoNotReplaceApproval(t *testing.T) {
	cases := []struct {
		name string
		edit func(*port.AccountObservation)
		code Code
	}{
		{"unknown", func(o *port.AccountObservation) { o.State = "unknown" }, Unavailable},
		{"unknown-empty", func(o *port.AccountObservation) { *o = port.AccountObservation{State: "unknown"} }, Unavailable},
		{"state", func(o *port.AccountObservation) { o.State = "other" }, Invalid},
		{"source", func(o *port.AccountObservation) { o.Source = "other" }, Invalid},
		{"principal-short", func(o *port.AccountObservation) { o.PrincipalKey = "a" }, Invalid},
		{"principal-uppercase", func(o *port.AccountObservation) { o.PrincipalKey = strings.Repeat("A", 64) }, Invalid},
		{"principal-nonhex", func(o *port.AccountObservation) { o.PrincipalKey = strings.Repeat("g", 64) }, Invalid},
		{"principal-unicode", func(o *port.AccountObservation) { o.PrincipalKey = strings.Repeat("é", 32) }, Invalid},
		{"zero", func(o *port.AccountObservation) { o.ObservedAtMillis = 0 }, Invalid},
		{"unsafe-observed", func(o *port.AccountObservation) { o.ObservedAtMillis = maxSafeMillis + 1 }, Invalid},
		{"unsafe-expiry", func(o *port.AccountObservation) { o.ExpiresAtMillis = maxSafeMillis + 1 }, Invalid},
		{"overflow", func(o *port.AccountObservation) { o.ObservedAtMillis, o.ExpiresAtMillis = ^uint64(0)-1, ^uint64(0) }, Invalid},
		{"same-expiry", func(o *port.AccountObservation) { o.ExpiresAtMillis = o.ObservedAtMillis }, Invalid},
		{"zero-expiry", func(o *port.AccountObservation) { o.ExpiresAtMillis = 0 }, Invalid},
		{"future", func(o *port.AccountObservation) { o.ObservedAtMillis++ }, Stale},
		{"expired", func(o *port.AccountObservation) { o.ObservedAtMillis, o.ExpiresAtMillis = 9000, 10000 }, Stale},
		{"old", func(o *port.AccountObservation) { o.ObservedAtMillis = 4999 }, Stale},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _, _ := fixture(t)
			g := approve(t, s, "selected", 0)
			o := observation()
			tc.edit(&o)
			refused(t, g, context.Background(), testScope, "selected", o, tc.code)
			if got, err := s.Approve(context.Background(), "failed", 1, o); got != nil || err != tc.code {
				t.Fatal(got != nil, err)
			}
			revision(t, s, 1)
			accepted(t, g, "selected")
			// A failed ID is not historical; only successful approval consumes it.
			approve(t, s, "failed", 1)
		})
	}
}

func TestClockBoundsAgeBoundaryAndRollback(t *testing.T) {
	for _, now := range []uint64{0, maxSafeMillis + 1, ^uint64(0)} {
		s, _, clock := fixture(t)
		clock.now = now
		if g, err := s.Approve(context.Background(), "first", 0, observation()); g != nil || err != Stale {
			t.Fatal(g != nil, err)
		}
		revision(t, s, 0)
	}
	s, _, clock := fixture(t)
	g := approve(t, s, "selected", 0)
	clock.now = 15000 // Exactly max age is accepted.
	accepted(t, g, "selected")
	clock.now = 15001
	refused(t, g, context.Background(), testScope, "selected", observation(), Stale)
	clock.now = 15000 // Earlier failed check established a clock watermark.
	refused(t, g, context.Background(), testScope, "selected", observation(), Stale)
	revision(t, s, 1)
	// Subtraction near the largest safe integer never overflows.
	s2, _, clock2 := fixture(t)
	clock2.now = maxSafeMillis - 1
	o := observation()
	o.ObservedAtMillis, o.ExpiresAtMillis = maxSafeMillis-5001, maxSafeMillis
	near, err := s2.Approve(context.Background(), "near-limit", 0, o)
	if near == nil || err != nil {
		t.Fatal(err)
	}
	clock2.now = maxSafeMillis
	refused(t, near, context.Background(), testScope, "near-limit", o, Stale)
}

func TestClockChangesDuringCallbackRefuseSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		now    uint64
		expiry uint64
	}{
		{"expiry", 10001, 10001},
		{"max-age", 15001, 20000},
		{"rollback", 9999, 20000},
		{"unsafe-clock", maxSafeMillis + 1, 20000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, clock := fixture(t)
			g := approve(t, s, "selected", 0)
			o := observation()
			o.ExpiresAtMillis = tc.expiry
			calls := 0
			err := g.WithCurrent(context.Background(), testScope, "selected", o, func(port.AccountApproval) error {
				calls++
				clock.now = tc.now
				return nil
			})
			if err != Stale || calls != 1 {
				t.Fatal(err, calls)
			}
			revision(t, s, 1)
		})
	}
}

func TestCancellationAndCallbackFailure(t *testing.T) {
	s, _, clock := fixture(t)
	g := approve(t, s, "selected", 0)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	refused(t, g, ctx, testScope, "selected", observation(), Cancelled)
	refused(t, g, nil, testScope, "selected", observation(), Invalid)
	if got, err := s.Approve(ctx, "cancelled", 1, observation()); got != nil || err != Cancelled {
		t.Fatal(err)
	}
	if _, err := s.Revoke(ctx, 1); err != Cancelled {
		t.Fatal(err)
	}
	if _, err := s.Revision(ctx); err != Cancelled {
		t.Fatal(err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	err := g.WithCurrent(ctx, testScope, "selected", observation(), func(port.AccountApproval) error { cancel(); return nil })
	if err != Cancelled {
		t.Fatal(err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	clock.hook = cancel // Cancellation during injected sampling, before callback.
	refused(t, g, ctx, testScope, "selected", observation(), Cancelled)
	clock.hook = nil
	ctx, cancel = context.WithCancel(context.Background())
	err = g.WithCurrent(ctx, testScope, "selected", observation(), func(port.AccountApproval) error {
		clock.hook = cancel // Cancellation during the final time recheck.
		return nil
	})
	clock.hook = nil
	if err != Cancelled {
		t.Fatal(err)
	}
	err = g.WithCurrent(context.Background(), testScope, "selected", observation(), func(port.AccountApproval) error { return errors.New("synthetic private callback content") })
	if err != Unavailable || strings.Contains(err.Error(), "private") {
		t.Fatal(err)
	}
	revision(t, s, 1)
	accepted(t, g, "selected")
}

func TestFailedCallbackStillRechecksTime(t *testing.T) {
	s, _, clock := fixture(t)
	g := approve(t, s, "selected", 0)
	err := g.WithCurrent(context.Background(), testScope, "selected", observation(), func(port.AccountApproval) error {
		clock.now = 20000
		return errors.New("synthetic callback failure")
	})
	if err != Stale {
		t.Fatal(err)
	}
}

func TestCancellationDuringApproveSamplingDoesNotMint(t *testing.T) {
	s, _, clock := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	clock.hook = cancel
	if g, err := s.Approve(ctx, "first", 0, observation()); g != nil || err != Cancelled {
		t.Fatal(g != nil, err)
	}
	clock.hook = nil
	revision(t, s, 0)
	approve(t, s, "first", 0)
}

func TestCASFailureAndHistoricalIDsPreserveCurrent(t *testing.T) {
	s, _, _ := fixture(t)
	g := approve(t, s, "first", 0)
	if got, err := s.Approve(context.Background(), "second", 0, observation()); got != nil || err != Mismatch {
		t.Fatal(err)
	}
	if _, err := s.Revoke(context.Background(), 0); err != Mismatch {
		t.Fatal(err)
	}
	for _, id := range []string{"", "space id", strings.Repeat("x", 121), "bad\x00"} {
		if got, err := s.Approve(context.Background(), id, 1, observation()); got != nil || err != Invalid {
			t.Fatal(err)
		}
	}
	if got, err := s.Approve(context.Background(), "first", 1, observation()); got != nil || err != Mismatch {
		t.Fatal(err)
	}
	accepted(t, g, "first")
	if _, err := s.Revoke(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Approve(context.Background(), "first", 2, observation()); got != nil || err != Mismatch {
		t.Fatal(err)
	}
	if _, err := s.Revoke(context.Background(), 1); err != Mismatch { // Stale no-op.
		t.Fatal(err)
	}
	if got, err := s.Revoke(context.Background(), 2); got != 2 || err != nil {
		t.Fatal(got, err)
	}
	approve(t, s, "second", 2)
}

func TestCapacityStillAllowsWithdrawal(t *testing.T) {
	s, _, clock := fixture(t)
	var current *Grant
	for n := 0; n < MaxApprovalIDs; n++ {
		current = approve(t, s, fmt.Sprintf("approval-%d", n), uint64(n))
	}
	if g, err := s.Approve(context.Background(), "overflow", MaxApprovalIDs, observation()); g != nil || err != Capacity {
		t.Fatal(g != nil, err)
	}
	accepted(t, current, "approval-1023")
	clock.now = 0 // Withdrawal works even with an unavailable clock.
	if got, err := s.Revoke(context.Background(), MaxApprovalIDs); got != MaxApprovalIDs+1 || err != nil {
		t.Fatal(got, err)
	}
	refused(t, current, context.Background(), testScope, "approval-1023", observation(), Stale)
	if g, err := s.Approve(context.Background(), "overflow", MaxApprovalIDs+1, observation()); g != nil || err != Capacity {
		t.Fatal(g != nil, err)
	}
	if g, err := s.Approve(context.Background(), "approval-0", MaxApprovalIDs+1, observation()); g != nil || err != Mismatch {
		t.Fatal(g != nil, err)
	}
	if got, err := s.Revoke(context.Background(), MaxApprovalIDs+1); got != MaxApprovalIDs+1 || err != nil {
		t.Fatal(got, err)
	}
}

func TestCASRacesSerializedByOwnerGate(t *testing.T) {
	s, _, _ := fixture(t)
	const contenders = 16
	start := make(chan struct{})
	results := make(chan error, contenders)
	for n := 0; n < contenders; n++ {
		go func() {
			<-start
			_, err := s.Approve(context.Background(), fmt.Sprintf("race-%d", n), 0, observation())
			results <- err
		}()
	}
	close(start)
	success := 0
	for range contenders {
		if err := <-results; err == nil {
			success++
		} else if err != Mismatch {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	revision(t, s, 1)
	// Approve and Revoke with the same CAS cannot both succeed.
	start = make(chan struct{})
	go func() {
		<-start
		_, err := s.Approve(context.Background(), "replacement", 1, observation())
		results <- err
	}()
	go func() { <-start; _, err := s.Revoke(context.Background(), 1); results <- err }()
	close(start)
	one, two := <-results, <-results
	if !((one == nil && two == Mismatch) || (one == Mismatch && two == nil)) {
		t.Fatal(one, two)
	}
	revision(t, s, 2)
}

func TestCallbackAndRevokeAreSerialized(t *testing.T) {
	s, _, _ := fixture(t)
	g := approve(t, s, "selected", 0)
	entered, withdrawStarted := make(chan struct{}), make(chan struct{})
	checked, withdrawn := make(chan error, 1), make(chan error, 1)
	go func() {
		checked <- g.WithCurrent(context.Background(), testScope, "selected", observation(), func(port.AccountApproval) error {
			close(entered)
			<-withdrawStarted // Synthetic synchronization only; production forbids IO.
			return nil
		})
	}()
	<-entered
	go func() {
		close(withdrawStarted)
		_, err := s.Revoke(context.Background(), 1)
		withdrawn <- err
	}()
	if err := <-checked; err != nil {
		t.Fatal(err)
	}
	if err := <-withdrawn; err != nil {
		t.Fatal(err)
	}
	refused(t, g, context.Background(), testScope, "selected", observation(), Stale)
}

func TestPostCallbackCurrentAndRevisionRecheck(t *testing.T) {
	// Test-only adversarial state corruption isolates both defensive comparisons;
	// public callers cannot write these fields or legally reenter under the Gate.
	for _, mutate := range []func(*Service){func(s *Service) { s.current = nil }, func(s *Service) { s.revision++ }} {
		s, _, _ := fixture(t)
		g := approve(t, s, "selected", 0)
		err := g.WithCurrent(context.Background(), testScope, "selected", observation(), func(port.AccountApproval) error { mutate(s); return nil })
		if err != Stale {
			t.Fatal(err)
		}
	}
}

func TestZeroServicesAreRefused(t *testing.T) {
	for _, s := range []*Service{nil, {}} {
		if g, err := s.Approve(context.Background(), "id", 0, observation()); g != nil || err != Invalid {
			t.Fatal(err)
		}
		if _, err := s.Revoke(context.Background(), 0); err != Invalid {
			t.Fatal(err)
		}
		if _, err := s.Revision(context.Background()); err != Invalid {
			t.Fatal(err)
		}
	}
}

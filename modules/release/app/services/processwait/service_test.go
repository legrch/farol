package processwait_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/app/services/processwait"
)

const birth = "Thu Oct 15 12:34:56 2026"

var epoch = time.Unix(1000, 0)

type probeFunc func(context.Context, time.Time) (port.ProcessObservation, error)

func (f probeFunc) Observe(ctx context.Context, until time.Time) (port.ProcessObservation, error) {
	return f(ctx, until)
}

type clock struct {
	mu      sync.Mutex
	now     time.Time
	sleeps  []time.Duration
	onNow   func()
	onSleep func(context.Context, time.Duration) error
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	now := c.now
	c.mu.Unlock()
	if c.onNow != nil {
		c.onNow()
	}
	return now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func (c *clock) Sleep(ctx context.Context, d time.Duration) error {
	c.mu.Lock()
	c.sleeps = append(c.sleeps, d)
	c.mu.Unlock()
	if c.onSleep != nil {
		return c.onSleep(ctx, d)
	}
	c.advance(d)
	return nil
}

func present(start string) port.ProcessObservation {
	return port.ProcessObservation{Presence: port.ProcessPresent, Start: start}
}

func absent() port.ProcessObservation { return port.ProcessObservation{Presence: port.ProcessAbsent} }

func checkFailure(t *testing.T, err error, code string, uncertain bool) {
	t.Helper()
	var f *processwait.Failure
	if !errors.As(err, &f) || f == nil || f.Code != code || f.Uncertain != uncertain || err.Error() != code {
		t.Fatalf("got %v (%#v), want %s uncertain=%v", err, f, code, uncertain)
	}
}

func service(t *testing.T, p port.ProcessProbe, c port.ProcessWaitClock) *processwait.Service {
	t.Helper()
	s, err := processwait.New(birth, p, c)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func confirmed(t *testing.T, p port.ProcessProbe, c port.ProcessWaitClock) *processwait.Service {
	t.Helper()
	var first atomic.Bool
	s := service(t, probeFunc(func(ctx context.Context, until time.Time) (port.ProcessObservation, error) {
		if first.CompareAndSwap(false, true) {
			return present(birth), nil
		}
		return p.Observe(ctx, until)
	}), c)
	if err := s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestConstructorAndPreflightHaveNoObservationEffects(t *testing.T) {
	var calls atomic.Int32
	p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
		calls.Add(1)
		return present(birth), nil
	})
	c := &clock{now: epoch, onNow: func() { t.Fatal("constructor called clock") }}
	for _, value := range []string{"", " padded", "padded ", "a\nb", "a\x00b", "a\u0085b", "a\u2028b", "a\u2029b", string([]byte{0xff}), strings.Repeat("x", 129), strings.Repeat("é", 65)} {
		if s, err := processwait.New(value, p, c); s != nil {
			t.Fatal("invalid constructor returned service")
		} else {
			checkFailure(t, err, "process_input", false)
		}
	}
	for _, value := range []string{birth, strings.Repeat("é", 64), "a  b"} {
		if _, err := processwait.New(value, p, c); err != nil {
			t.Fatal(err)
		}
	}
	_, err := processwait.New(birth, nil, c)
	checkFailure(t, err, "process_dependency", false)
	_, err = processwait.New(birth, p, nil)
	checkFailure(t, err, "process_dependency", false)
	c = &clock{now: epoch}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tt := range []struct {
		ctx   context.Context
		until time.Time
		code  string
	}{
		{nil, epoch.Add(time.Second), "process_input"},
		{context.Background(), time.Time{}, "process_input"},
		{context.Background(), epoch, "process_unknown"},
		{context.Background(), epoch.Add(-time.Second), "process_unknown"},
		{canceled, epoch.Add(time.Second), "context_cancelled"},
	} {
		_, err := processwait.Capture(tt.ctx, tt.until, p, c)
		checkFailure(t, err, tt.code, false)
		s := service(t, p, c)
		checkFailure(t, s.ConfirmIdentity(tt.ctx, tt.until), tt.code, false)
		checkFailure(t, s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_identity", false)
	}
	_, err = processwait.Capture(context.Background(), epoch.Add(time.Second), nil, c)
	checkFailure(t, err, "process_dependency", false)
	_, err = processwait.Capture(context.Background(), epoch.Add(time.Second), p, nil)
	checkFailure(t, err, "process_dependency", false)
	var zero processwait.Service
	var missing *processwait.Service
	for _, s := range []*processwait.Service{&zero, missing} {
		checkFailure(t, s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), "process_dependency", false)
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_dependency", false)
	}
	if calls.Load() != 0 {
		t.Fatalf("preflight observed %d times", calls.Load())
	}
}

func TestCaptureValidatesEveryObservationAndPreservesBytes(t *testing.T) {
	for _, o := range []port.ProcessObservation{
		{}, absent(), {Presence: port.ProcessPresence(99)},
		{Presence: port.ProcessAbsent, Start: birth}, {Presence: port.ProcessUnknown, Start: birth},
		present(""), present(" x"), present("x\tq"), present("x\nq"), present("x\u0085q"), present("x\u2028q"), present("x\u2029q"),
		present(string([]byte{0xff})), present(strings.Repeat("x", 129)), present(strings.Repeat("é", 65)),
	} {
		t.Run(fmt.Sprintf("%d/%q", o.Presence, o.Start), func(t *testing.T) {
			p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) { return o, nil })
			got, err := processwait.Capture(context.Background(), epoch.Add(time.Second), p, &clock{now: epoch})
			if got != "" {
				t.Fatal("invalid observation leaked token")
			}
			checkFailure(t, err, "process_unknown", false)
		})
	}
	for _, expected := range []string{birth, strings.Repeat("é", 64), "two  spaces"} {
		p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) { return present(expected), nil })
		got, err := processwait.Capture(context.Background(), epoch.Add(time.Second), p, &clock{now: epoch})
		if got != expected || err != nil {
			t.Fatalf("capture got %q %v", got, err)
		}
	}
}

func TestConfirmationWitnessIsStickyAndBoundToTheOriginalProbe(t *testing.T) {
	for _, o := range []port.ProcessObservation{absent(), present("another birth"), {}} {
		var calls atomic.Int32
		p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
			calls.Add(1)
			return o, nil
		})
		s := service(t, p, &clock{now: epoch})
		code := "process_identity"
		if o.Presence == port.ProcessUnknown {
			code = "process_unknown"
		}
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_identity", false)
		checkFailure(t, s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), code, false)
		checkFailure(t, s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_identity", false)
		if calls.Load() != 1 {
			t.Fatalf("sticky confirmation made %d probes", calls.Load())
		}
	}
	var calls atomic.Int32
	p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
		if calls.Add(1) == 1 {
			return present(birth), nil
		}
		return absent(), nil
	})
	c := &clock{now: epoch}
	s := service(t, p, c)
	copyBefore := *s
	if err := s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	copyAfter := *s
	other := service(t, p, c)
	checkFailure(t, other.WaitExit(context.Background(), epoch.Add(time.Second)), "process_identity", false)
	checkFailure(t, copyBefore.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
	if err := copyAfter.WaitExit(context.Background(), epoch.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	for _, v := range []*processwait.Service{s, &copyBefore, &copyAfter} {
		checkFailure(t, v.WaitExit(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
	}
	if calls.Load() != 2 || len(c.sleeps) != 0 {
		t.Fatal("immediate exit did extra work")
	}
}

func TestWaitPreservesAbsoluteBudgetAndClampsEverySleep(t *testing.T) {
	c := &clock{now: epoch}
	until := epoch.Add(250 * time.Millisecond)
	var polls int
	p := probeFunc(func(ctx context.Context, got time.Time) (port.ProcessObservation, error) {
		polls++
		if got != until {
			t.Fatalf("renewed probe budget: %v want %v", got, until)
		}
		if polls == 1 {
			c.advance(30 * time.Millisecond)
		}
		return present(birth), nil
	})
	s := confirmed(t, p, c)
	checkFailure(t, s.WaitExit(context.Background(), until), "process_running", false)
	want := []time.Duration{100 * time.Millisecond, 100 * time.Millisecond, 20 * time.Millisecond}
	if fmt.Sprint(c.sleeps) != fmt.Sprint(want) || polls != 3 || c.Now() != until {
		t.Fatalf("polls=%d sleeps=%v now=%v", polls, c.sleeps, c.Now())
	}
	checkFailure(t, s.WaitExit(context.Background(), until.Add(time.Second)), "process_consumed", false)
}

type deadlineContext struct {
	context.Context
	end time.Time
}

func (c deadlineContext) Deadline() (time.Time, bool) { return c.end, true }

func TestEarlierContextDeadlineDoesNotReplaceTheOriginalProbeArgument(t *testing.T) {
	c := &clock{now: epoch}
	until := epoch.Add(time.Second)
	early := epoch.Add(35 * time.Millisecond)
	ctx := deadlineContext{context.Background(), early}
	p := probeFunc(func(gotCtx context.Context, gotUntil time.Time) (port.ProcessObservation, error) {
		if gotCtx != ctx || gotUntil != until {
			t.Fatal("changed caller context or original absolute deadline")
		}
		return present(birth), nil
	})
	s := confirmed(t, p, c)
	checkFailure(t, s.WaitExit(ctx, until), "process_running", false)
	if len(c.sleeps) != 1 || c.sleeps[0] != 35*time.Millisecond {
		t.Fatalf("context budget not clamped: %v", c.sleeps)
	}
	_, err := processwait.Capture(ctx, until, p, c)
	checkFailure(t, err, "process_unknown", false)
}

func TestLateResultsCannotEstablishIdentityExitReuseOrRunning(t *testing.T) {
	for _, o := range []port.ProcessObservation{absent(), present(birth), present("new birth")} {
		for _, method := range []string{"capture", "confirm", "wait"} {
			t.Run(fmt.Sprintf("%s/%d/%s", method, o.Presence, o.Start), func(t *testing.T) {
				c := &clock{now: epoch}
				p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
					c.advance(time.Second)
					return o, nil
				})
				var err error
				switch method {
				case "capture":
					var got string
					got, err = processwait.Capture(context.Background(), epoch.Add(time.Second), p, c)
					if got != "" {
						t.Fatal("late token escaped")
					}
				case "confirm":
					s := service(t, p, c)
					err = s.ConfirmIdentity(context.Background(), epoch.Add(time.Second))
					checkFailure(t, s.WaitExit(context.Background(), epoch.Add(2*time.Second)), "process_identity", false)
				case "wait":
					s := confirmed(t, p, c)
					err = s.WaitExit(context.Background(), epoch.Add(time.Second))
				}
				checkFailure(t, err, "process_unknown", true)
			})
		}
	}
}

func TestExpiryAtFinalSuccessBoundaryCannotPublishAWitnessOrExit(t *testing.T) {
	for _, method := range []string{"capture", "confirm", "wait"} {
		t.Run(method, func(t *testing.T) {
			c := &clock{now: epoch}
			p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
				if method == "wait" {
					return absent(), nil
				}
				return present(birth), nil
			})
			var s *processwait.Service
			if method == "wait" {
				s = confirmed(t, p, c)
			} else {
				s = service(t, p, c)
			}
			var checks int
			c.onNow = func() {
				checks++
				// The clock returns the third check's in-budget value while
				// advancing time before the final success check can occur.
				if checks == 3 {
					c.advance(time.Second)
				}
			}
			var err error
			switch method {
			case "capture":
				var got string
				got, err = processwait.Capture(context.Background(), epoch.Add(time.Second), p, c)
				if got != "" {
					t.Fatal("expired capture published token")
				}
				checkFailure(t, s.WaitExit(context.Background(), epoch.Add(2*time.Second)), "process_identity", false)
			case "confirm":
				err = s.ConfirmIdentity(context.Background(), epoch.Add(time.Second))
				checkFailure(t, s.WaitExit(context.Background(), epoch.Add(2*time.Second)), "process_identity", false)
			case "wait":
				err = s.WaitExit(context.Background(), epoch.Add(time.Second))
			}
			checkFailure(t, err, "process_unknown", true)
		})
	}
}

func TestObservationFailureClassificationAndNoAbsenceFromError(t *testing.T) {
	var typedNil *port.ProcessProbeFailure
	for _, tt := range []struct {
		err       error
		code      string
		uncertain bool
	}{
		{&port.ProcessProbeFailure{Kind: port.ProcessProbeUnknown}, "process_unknown", false},
		{&port.ProcessProbeFailure{Kind: port.ProcessProbeInput}, "process_unknown", false},
		{&port.ProcessProbeFailure{Kind: port.ProcessProbeCanceled}, "context_cancelled", true},
		{&port.ProcessProbeFailure{Kind: port.ProcessProbeDeadline}, "process_unknown", true},
		{&port.ProcessProbeFailure{Kind: port.ProcessProbeCleanupUnknown}, "process_unknown", true},
		{&port.ProcessProbeFailure{Kind: port.ProcessProbeFailureKind(99)}, "process_unknown", true},
		{errors.New("private native details"), "process_unknown", true},
		{context.Canceled, "context_cancelled", true},
		{context.DeadlineExceeded, "process_unknown", true},
		{typedNil, "process_unknown", true},
	} {
		p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
			return absent(), fmt.Errorf("wrapped: %w", tt.err)
		})
		_, err := processwait.Capture(context.Background(), epoch.Add(time.Second), p, &clock{now: epoch})
		checkFailure(t, err, tt.code, tt.uncertain)
		s := confirmed(t, p, &clock{now: epoch})
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), tt.code, tt.uncertain)
	}
	// An earlier completed matching poll cannot make a later unknown probe running.
	c := &clock{now: epoch}
	var count int
	p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
		count++
		if count == 1 {
			return present(birth), nil
		}
		c.advance(time.Second)
		return absent(), &port.ProcessProbeFailure{Kind: port.ProcessProbeDeadline}
	})
	s := confirmed(t, p, c)
	checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_unknown", true)
}

func TestWaitRejectsReuseAndConsumesFailedOrInvalidWait(t *testing.T) {
	for _, o := range []port.ProcessObservation{present("new birth"), {}, {Presence: port.ProcessAbsent, Start: birth}} {
		var calls int
		p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) { calls++; return o, nil })
		s := confirmed(t, p, &clock{now: epoch})
		code := "process_unknown"
		if o.Presence == port.ProcessPresent {
			code = "process_reused"
		}
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), code, false)
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
		if calls != 1 {
			t.Fatal("failed wait repeated a probe")
		}
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tt := range []struct {
		ctx   context.Context
		until time.Time
		code  string
	}{
		{nil, epoch.Add(time.Second), "process_input"},
		{context.Background(), time.Time{}, "process_input"},
		{context.Background(), epoch, "process_unknown"},
		{canceled, epoch.Add(time.Second), "context_cancelled"},
	} {
		p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
			t.Fatal("invalid wait probed")
			return absent(), nil
		})
		s := confirmed(t, p, &clock{now: epoch})
		checkFailure(t, s.WaitExit(tt.ctx, tt.until), tt.code, false)
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
	}
}

func TestCancellationAfterProbeOrSleepRefusesSuccess(t *testing.T) {
	for _, method := range []string{"capture", "confirm", "wait", "sleep", "now"} {
		t.Run(method, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			c := &clock{now: epoch}
			p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
				if method != "sleep" {
					cancel()
					return absent(), nil
				}
				return present(birth), nil
			})
			var err error
			switch method {
			case "capture":
				_, err = processwait.Capture(ctx, epoch.Add(time.Second), p, c)
			case "confirm":
				err = service(t, p, c).ConfirmIdentity(ctx, epoch.Add(time.Second))
			case "wait", "sleep":
				s := confirmed(t, p, c)
				c.onSleep = func(context.Context, time.Duration) error { cancel(); return context.Canceled }
				err = s.WaitExit(ctx, epoch.Add(time.Second))
			case "now":
				c.onNow = cancel
				_, err = processwait.Capture(ctx, epoch.Add(time.Second), p, c)
			}
			checkFailure(t, err, "context_cancelled", method != "now")
		})
	}
}

func TestSleepFailureAndLateSleepNeverTriggerAnotherProbe(t *testing.T) {
	for _, sleepErr := range []error{nil, errors.New("timer failed"), context.DeadlineExceeded} {
		c := &clock{now: epoch}
		c.onSleep = func(context.Context, time.Duration) error { c.advance(time.Second); return sleepErr }
		var calls int
		p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) { calls++; return present(birth), nil })
		s := confirmed(t, p, c)
		err := s.WaitExit(context.Background(), epoch.Add(time.Second))
		if sleepErr == nil {
			checkFailure(t, err, "process_running", false)
		} else {
			checkFailure(t, err, "process_unknown", true)
		}
		if calls != 1 {
			t.Fatal("late sleep polled again")
		}
	}
}

func TestConcurrentConfirmationAndWaitReserveBeforeCallingPorts(t *testing.T) {
	for _, method := range []string{"confirm", "wait"} {
		t.Run(method, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
				calls.Add(1)
				close(entered)
				<-release
				if method == "confirm" {
					return present(birth), nil
				}
				return absent(), nil
			})
			c := &clock{now: epoch}
			var s *processwait.Service
			if method == "confirm" {
				s = service(t, p, c)
			} else {
				s = confirmed(t, p, c)
			}
			invoke := func() error {
				if method == "confirm" {
					return s.ConfirmIdentity(context.Background(), epoch.Add(time.Second))
				}
				return s.WaitExit(context.Background(), epoch.Add(time.Second))
			}
			first := make(chan error, 1)
			go func() { first <- invoke() }()
			<-entered
			others := make(chan error, 16)
			for range 16 {
				go func() { others <- invoke() }()
			}
			for range 16 {
				checkFailure(t, <-others, "process_consumed", false)
			}
			if method == "confirm" {
				checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_identity", false)
			}
			close(release)
			if err := <-first; err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatalf("concurrent calls observed %d times", calls.Load())
			}
		})
	}
}

func TestReentrantProbeClockAndSleepNeverHoldServiceGate(t *testing.T) {
	c := &clock{now: epoch}
	var s *processwait.Service
	var phase int
	p := probeFunc(func(context.Context, time.Time) (port.ProcessObservation, error) {
		checkFailure(t, s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
		if phase == 0 {
			checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_identity", false)
			return present(birth), nil
		}
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
		return present(birth), nil
	})
	s = service(t, p, c)
	c.onNow = func() {
		checkFailure(t, s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
	}
	if err := s.ConfirmIdentity(context.Background(), epoch.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	phase = 1
	c.onSleep = func(context.Context, time.Duration) error {
		checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_consumed", false)
		c.advance(time.Second)
		return nil
	}
	checkFailure(t, s.WaitExit(context.Background(), epoch.Add(time.Second)), "process_running", false)
}

package processprobe

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

type observationResult struct {
	value port.ProcessObservation
	err   error
}

func TestJoinRetainsOriginalLateObservationAndStickyFailure(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	p, b, c := completeFixture("", "", 1, true)
	b.existence = func(int) bool { close(entered); <-release; return true }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := observeAsync(p, ctx, time.Now().Add(3*time.Second))
	await(t, entered)
	cancel()
	requireKind(t, awaitResult(t, result).err, port.ProcessProbeCleanupUnknown)
	joined := make(chan error, 1)
	go func() { joined <- p.Join() }()
	select {
	case <-joined:
		t.Fatal("Join released a still entered original observation")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-joined:
		requireKind(t, err, port.ProcessProbeCleanupUnknown)
	case <-time.After(time.Second):
		t.Fatal("original drain not observed")
	}
	_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCleanupUnknown)
	if b.prepares.Load() != 1 || c.starts.Load() != 1 || c.waits.Load() != 1 || c.kills.Load() != 0 || b.exists.Load() != 1 {
		t.Fatal("original observation was repeated")
	}
}

func observeAsync(p *Probe, ctx context.Context, until time.Time) <-chan observationResult {
	done := make(chan observationResult, 1)
	go func() {
		v, err := p.Observe(ctx, until)
		done <- observationResult{v, err}
	}()
	return done
}

func await(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("fixture failed to settle")
	}
}

func awaitResult(t *testing.T, ch <-chan observationResult) observationResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("unbounded observation")
		return observationResult{}
	}
}

func TestCancellationDeadlineAndOverflowShareOriginalStop(t *testing.T) {
	for _, trigger := range []string{"cancel", "deadline", "contextDeadline", "overflow", "stderrOverflow", "collide"} {
		t.Run(trigger, func(t *testing.T) {
			waiting, killed := make(chan struct{}), make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			until := time.Now().Add(time.Second)
			if trigger == "deadline" {
				until = time.Now().Add(40 * time.Millisecond)
			}
			if trigger == "contextDeadline" {
				ctx, cancel = context.WithTimeout(context.Background(), 40*time.Millisecond)
				defer cancel()
			}
			c := &fixtureChild{killFn: func() error { close(killed); return nil }}
			b := &fixtureBoundary{build: func(out, err io.Writer) child {
				c.waitFn = func() (status, error) {
					close(waiting)
					if trigger == "overflow" || trigger == "collide" {
						copyOutput(out, strings.Repeat("x", streamLimit+1))
						if trigger == "collide" {
							cancel()
						}
					} else {
						copyOutput(out, birth)
					}
					if trigger == "stderrOverflow" {
						copyOutput(err, strings.Repeat("x", streamLimit+1))
					}
					<-killed
					if trigger != "stderrOverflow" {
						copyOutput(err, "")
					}
					return status{exited: true, code: -1}, nil
				}
				return c
			}}
			p := newProbe(23456, b)
			done := observeAsync(p, ctx, until)
			await(t, waiting)
			if trigger == "cancel" {
				cancel()
			}
			r := awaitResult(t, done)
			want := port.ProcessProbeCanceled
			if trigger == "deadline" || trigger == "contextDeadline" {
				want = port.ProcessProbeDeadline
			}
			if trigger == "overflow" || trigger == "stderrOverflow" {
				want = port.ProcessProbeUnknown
			}
			if trigger == "collide" {
				var f *port.ProcessProbeFailure
				if !errors.As(r.err, &f) || (f.Kind != port.ProcessProbeUnknown && f.Kind != port.ProcessProbeCanceled) {
					t.Fatalf("unexpected collision outcome: %v", r.err)
				}
			} else {
				requireKind(t, r.err, want)
			}
			if r.value.Presence != port.ProcessUnknown || c.starts.Load() != 1 || c.waits.Load() != 1 || c.kills.Load() != 1 || b.exists.Load() != 0 {
				t.Fatalf("lost exact child or disclosed late result: %#v starts=%d waits=%d kills=%d", r.value, c.starts.Load(), c.waits.Load(), c.kills.Load())
			}
			_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
			requireKind(t, err, failureKind(r.err))
			if b.prepares.Load() != 1 {
				t.Fatal("tainted retry")
			}
		})
	}
}

func TestBoundedCallerRetainsLateStartAndOriginalChild(t *testing.T) {
	entered, releaseStart, killed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &fixtureChild{
		startFn: func() error { close(entered); <-releaseStart; return nil },
		killFn:  func() error { close(killed); return nil },
	}
	b := &fixtureBoundary{build: func(out, err io.Writer) child {
		c.waitFn = func() (status, error) {
			<-killed
			copyOutput(out, birth) // late clean output cannot upgrade cancellation
			copyOutput(err, "")
			return status{exited: true, code: 0}, nil
		}
		return c
	}}
	p := newProbe(23456, b)
	done := observeAsync(p, ctx, time.Now().Add(10*time.Second))
	await(t, entered)
	start := time.Now()
	cancel()
	r := awaitResult(t, done)
	requireKind(t, r.err, port.ProcessProbeCleanupUnknown)
	if time.Since(start) > cleanupCap+500*time.Millisecond {
		t.Fatal("cleanup cap renewed")
	}
	owner := p.retained
	if owner == nil || c.kills.Load() != 0 || c.waits.Load() != 0 {
		t.Fatal("lost pending Start owner")
	}
	_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeCleanupUnknown)
	close(releaseStart)
	await(t, owner.done)
	if p.retained != owner || c.starts.Load() != 1 || c.waits.Load() != 1 || c.kills.Load() != 1 || b.prepares.Load() != 1 {
		t.Fatal("late Start changed owner or launched another child")
	}
	if r.value.Presence != port.ProcessUnknown {
		t.Fatal("late Start upgraded result")
	}
}

func TestWaitAndKillAcknowledgementAreIndependent(t *testing.T) {
	for _, blocked := range []string{"wait", "kill"} {
		t.Run(blocked, func(t *testing.T) {
			waiting, killEntered, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			c := &fixtureChild{killFn: func() error {
				close(killEntered)
				if blocked == "kill" {
					<-release
				}
				return nil
			}}
			b := &fixtureBoundary{build: func(out, err io.Writer) child {
				c.waitFn = func() (status, error) {
					close(waiting)
					<-killEntered
					if blocked == "wait" {
						<-release
					}
					copyOutput(out, "")
					copyOutput(err, "")
					return status{exited: true, code: 0}, nil
				}
				return c
			}}
			p := newProbe(23456, b)
			done := observeAsync(p, ctx, time.Now().Add(10*time.Second))
			await(t, waiting)
			cancel()
			await(t, killEntered)
			r := awaitResult(t, done)
			requireKind(t, r.err, port.ProcessProbeCleanupUnknown)
			owner := p.retained
			if owner == nil {
				t.Fatal("lost blocked primitive")
			}
			close(release)
			await(t, owner.done)
			owner.stop() // stale cancellation/deadline after reap cannot signal
			owner.stop()
			if c.starts.Load() != 1 || c.waits.Load() != 1 || c.kills.Load() != 1 || b.exists.Load() != 0 {
				t.Fatal("late cleanup changed exact child")
			}
		})
	}
}

func TestKillFailureStaysCleanupUnknownAfterCleanWait(t *testing.T) {
	waiting, killed := make(chan struct{}), make(chan struct{})
	c := &fixtureChild{killFn: func() error { close(killed); return errors.New("refused") }}
	b := &fixtureBoundary{build: func(out, err io.Writer) child {
		c.waitFn = func() (status, error) {
			close(waiting)
			<-killed
			copyOutput(out, birth)
			copyOutput(err, "")
			return status{exited: true, code: 0}, nil
		}
		return c
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := newProbe(23456, b)
	done := observeAsync(p, ctx, time.Now().Add(time.Second))
	await(t, waiting)
	cancel()
	requireKind(t, awaitResult(t, done).err, port.ProcessProbeCleanupUnknown)
	if c.kills.Load() != 1 {
		t.Fatal("kill retried")
	}
}

func TestLateExistenceCannotBecomeAbsence(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	p, b, c := completeFixture("", "", 0, false)
	b.existence = func(int) bool { close(entered); <-release; return true }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := observeAsync(p, ctx, time.Now().Add(time.Second))
	await(t, entered)
	cancel()
	close(release)
	r := awaitResult(t, done)
	requireKind(t, r.err, port.ProcessProbeCanceled)
	if r.value.Presence != port.ProcessUnknown || c.kills.Load() != 0 {
		t.Fatal("late absence or stale Kill")
	}
}

func TestSerializedWaitingIsCancelableAndUsesOriginalDeadline(t *testing.T) {
	waiting, release := make(chan struct{}), make(chan struct{})
	c := &fixtureChild{}
	b := &fixtureBoundary{build: func(out, err io.Writer) child {
		c.waitFn = func() (status, error) {
			close(waiting)
			<-release
			copyOutput(out, birth)
			copyOutput(err, "")
			return status{exited: true, code: 0}, nil
		}
		return c
	}}
	p := newProbe(23456, b)
	done := observeAsync(p, context.Background(), time.Now().Add(time.Second))
	await(t, waiting)
	ctx, cancel := context.WithCancel(context.Background())
	second := observeAsync(p, ctx, time.Now().Add(time.Second))
	cancel()
	requireKind(t, awaitResult(t, second).err, port.ProcessProbeCanceled)
	_, err := p.Observe(context.Background(), time.Now().Add(20*time.Millisecond))
	requireKind(t, err, port.ProcessProbeDeadline)
	if b.prepares.Load() != 1 {
		t.Fatal("concurrent launch")
	}
	close(release)
	if r := awaitResult(t, done); r.err != nil || r.value.Start != birth {
		t.Fatalf("first observation: %#v", r)
	}
}

func TestStaleStopAfterReapDoesNotSignal(t *testing.T) {
	p, b, c := completeFixture(birth, "", 0, false)
	o := newObservation(context.Background(), time.Now().Add(time.Second), p.PID(), b)
	o.run()
	await(t, o.done)
	for range 100 {
		o.stop()
	}
	if c.kills.Load() != 0 {
		t.Fatal("stale stop signaled a reaped child")
	}
	got, err := o.result()
	if err != nil || got.Start != birth {
		t.Fatal("stale stop tainted completed observation")
	}
}

func TestEffectiveDeadlineIsSelectedOnceBeforeNativeStart(t *testing.T) {
	for _, source := range []string{"observationCap", "caller", "context"} {
		t.Run(source, func(t *testing.T) {
			waiting, killed := make(chan struct{}), make(chan struct{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			until := time.Now().Add(time.Hour)
			var expected time.Time
			if source == "caller" {
				until = time.Now().Add(2 * time.Second)
				expected = until
			}
			if source == "context" {
				ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(2*time.Second))
				defer cancel()
				expected, _ = ctx.Deadline()
			}
			c := &fixtureChild{killFn: func() error { close(killed); return nil }}
			b := &fixtureBoundary{build: func(out, err io.Writer) child {
				c.waitFn = func() (status, error) {
					close(waiting)
					<-killed
					copyOutput(out, birth)
					copyOutput(err, "")
					return status{exited: true, code: -1}, nil
				}
				return c
			}}
			p := newProbe(23456, b)
			entry := time.Now()
			done := observeAsync(p, ctx, until)
			await(t, waiting)
			got := p.retained.deadline
			if source == "observationCap" {
				if got.Before(entry.Add(observationCap)) || got.After(time.Now().Add(observationCap)) {
					t.Fatal("observation cap changed")
				}
			} else if got != expected {
				t.Fatal("original absolute/monotonic deadline changed")
			}
			cancel()
			requireKind(t, awaitResult(t, done).err, port.ProcessProbeCanceled)
		})
	}
}

func TestWrapperCopySharesStickyFailure(t *testing.T) {
	p, b, _ := completeFixture("bad\x00token", "", 0, false)
	copy := *p
	_, err := p.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeUnknown)
	_, err = copy.Observe(context.Background(), time.Now().Add(time.Second))
	requireKind(t, err, port.ProcessProbeUnknown)
	if b.prepares.Load() != 1 {
		t.Fatal("copied wrapper bypassed sticky failure")
	}
}

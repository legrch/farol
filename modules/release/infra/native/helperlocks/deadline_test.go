//go:build linux || darwin

package helperlocks

import (
	"context"
	"errors"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// lagContext is a context-timer delivery fixture. Its absolute deadline is real;
// Done/Err intentionally never deliver it. It does not simulate native I/O.
type lagContext struct {
	context.Context
	deadline time.Time
}

func (c lagContext) Deadline() (time.Time, bool) { return c.deadline, true }
func (c lagContext) Done() <-chan struct{}       { return nil }
func (c lagContext) Err() error                  { return nil }

type countDeadlineContext struct {
	context.Context
	deadline time.Time
	calls    atomic.Int32
}

func (c *countDeadlineContext) Deadline() (time.Time, bool) { c.calls.Add(1); return c.deadline, true }

func TestContextDeadlinesCapturedOnce(t *testing.T) {
	f := setup(t)
	ctx := &countDeadlineContext{Context: context.Background(), deadline: time.Now().Add(time.Minute)}
	l, e := AcquireUpdate(ctx, f.dir, ctx.deadline.Add(time.Hour))
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	if ctx.calls.Load() != 1 {
		t.Fatal("acquire renewed context deadline")
	}
	callctx := &countDeadlineContext{Context: context.Background(), deadline: ctx.deadline.Add(-time.Second)}
	if e = l.WithFile(callctx, func(*os.File, Identity) error { return nil }); e != nil {
		t.Fatal(e)
	}
	if callctx.calls.Load() != 1 {
		t.Fatal("callback renewed context deadline")
	}
	if l.owner.until != ctx.deadline {
		t.Fatal("call budget changed captured lifetime")
	}
}

func await(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatal("fixture witness not reached")
	}
}
func noResult(t *testing.T, ch <-chan error) {
	t.Helper()
	select {
	case e := <-ch:
		t.Fatalf("abandoned actual active operation: %v", e)
	default:
	}
}
func waitClosing(t *testing.T, o *owner) {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for {
		o.mu.Lock()
		closing := o.closing
		o.mu.Unlock()
		if closing {
			return
		}
		if !time.Now().Before(until) {
			t.Fatal("Close did not enter")
		}
		runtime.Gosched()
	}
}

func TestNativeEntryDeadlineRetainsActualOwnershipUntilReturn(t *testing.T) {
	for _, kind := range []string{"original", "acquire-context"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			f := setup(t)
			f.put(t, "lock", 0600)
			// The same generous fixed 5s bound is set before invocation, witnessed
			// after the actual flock, then awaited unchanged. No rescheduled budget.
			deadline := time.Now().Add(5 * time.Second)
			until := deadline
			ctx := context.Context(context.Background())
			if kind == "acquire-context" {
				ctx = lagContext{context.Background(), deadline}
				until = deadline.Add(time.Minute)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			result := make(chan error, 1)
			var closes atomic.Int32
			go func() {
				l, e := acquire(ctx, f.dir, until, false, hooks{
					flock: func(fd, flags int) error {
						e := unix.Flock(fd, flags)
						if e != nil {
							return e
						}
						close(entered)
						<-release
						return nil
					},
					close: func(f *os.File) error { closes.Add(1); return f.Close() },
				})
				if l != nil {
					_ = l.Close()
				}
				result <- e
			}()
			await(t, entered)
			if !time.Now().Before(deadline) {
				t.Fatal("native entry fixture missed its original deadline")
			}
			probe(t, f, "lock", true)
			<-time.After(time.Until(deadline))
			noResult(t, result)
			if closes.Load() != 0 {
				t.Fatal("deadline was treated as cleanup evidence")
			}
			probe(t, f, "lock", true)
			close(release)
			select {
			case e := <-result:
				failure(t, e, "lock_deadline", false, false)
				if !errors.Is(e, context.DeadlineExceeded) {
					t.Fatal("absolute deadline cause lost")
				}
			case <-time.After(10 * time.Second):
				t.Fatal("native return did not complete cleanup")
			}
			if closes.Load() != 1 {
				t.Fatal("owned description not closed exactly once")
			}
			probe(t, f, "lock", false)
		})
	}
}

func TestActiveCallbackAndConcurrentCloseCannotBeAbandoned(t *testing.T) {
	f := setup(t)
	f.put(t, "lock", 0600)
	var closes atomic.Int32
	l := f.acquire(t, false, hooks{close: func(f *os.File) error { closes.Add(1); return f.Close() }})
	copy := *l
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	callbackCause := errors.New("private callback failure")
	active := make(chan error, 1)
	go func() {
		active <- l.WithFile(ctx, func(*os.File, Identity) error { close(entered); <-release; return callbackCause })
	}()
	await(t, entered)
	cancel()
	// Gate waiting observes cancellation while the authoritative callback is
	// still active. It does not release the owner or start another callback.
	waitctx, waitcancel := context.WithCancel(context.Background())
	waitcancel()
	failure(t, copy.Verify(waitctx), "lock_canceled", false, false)
	closed := make(chan error, 1)
	go func() { closed <- copy.Close() }()
	waitClosing(t, l.owner)
	noResult(t, active)
	noResult(t, closed)
	if closes.Load() != 0 {
		t.Fatal("closed a still-borrowed authoritative File")
	}
	probe(t, f, "lock", true)
	close(release)
	select {
	case e := <-active:
		failure(t, e, "lock_callback", true, false)
		if !errors.Is(e, callbackCause) || !errors.Is(e, context.Canceled) {
			t.Fatal("callback/cancel causes lost")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("callback failed to return")
	}
	select {
	case e := <-closed:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close abandoned callback")
	}
	if closes.Load() != 1 {
		t.Fatal("close count")
	}
	probe(t, f, "lock", false)
}

func TestGateWaitHasIndependentAbsoluteTimerAndNoRenewal(t *testing.T) {
	f := setup(t)
	f.put(t, "lock", 0600)
	deadline := time.Now().Add(5 * time.Second)
	acquirectx := lagContext{context.Background(), deadline}
	l, e := AcquireUpdate(acquirectx, f.dir, deadline.Add(time.Minute))
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	active := make(chan error, 1)
	go func() {
		active <- l.WithFile(context.Background(), func(*os.File, Identity) error { close(entered); <-release; return nil })
	}()
	await(t, entered)
	if !time.Now().Before(deadline) {
		t.Fatal("callback entry fixture missed fixed bound")
	}
	waiting := make(chan error, 1)
	go func() { waiting <- l.Verify(lagContext{context.Background(), deadline.Add(time.Hour)}) }()
	select {
	case e := <-waiting:
		failure(t, e, "lock_deadline", false, false)
		if time.Now().Before(deadline) {
			t.Fatal("gate deadline fired early")
		}
	case <-time.After(time.Until(deadline) + 5*time.Second):
		t.Fatal("gate depended on lagging context delivery")
	}
	noResult(t, active)
	probe(t, f, "lock", true)
	close(release)
	select {
	case e := <-active:
		failure(t, e, "lock_deadline", false, false)
	case <-time.After(10 * time.Second):
		t.Fatal("callback did not complete")
	}
	failure(t, l.Verify(context.Background()), "lock_deadline", false, false)
	// Expiry cannot suppress mandatory cleanup or turn confirmed close into
	// synthetic failure. It does not erase the prior failed operation.
	if e = l.Close(); e != nil {
		t.Fatal(e)
	}
	probe(t, f, "lock", false)
}

func TestCallbackNativeErrorAndLaggingDeadlineBothRetained(t *testing.T) {
	f := setup(t)
	l := f.acquire(t, false, hooks{})
	deadline := time.Now().Add(5 * time.Second)
	entered := false
	e := l.WithFile(lagContext{context.Background(), deadline}, func(*os.File, Identity) error {
		entered = true
		if !time.Now().Before(deadline) {
			t.Fatal("callback missed original fixed 5s deadline")
		}
		<-time.After(time.Until(deadline))
		return unix.EIO
	})
	if !entered {
		t.Fatal("callback not exercised")
	}
	failure(t, e, "lock_callback", true, false)
	if !errors.Is(e, unix.EIO) || !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("callback/native deadline cause lost")
	}
}

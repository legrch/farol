package codex

// Pure CPU original-launch/cleanup interleavings. The controlled Process has no
// native child or socket; the authority cases use the existing net.Pipe script.
// These tests do not qualify native termination, exit, accounts or providers.
import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/domain"
)

type clientCloseProcess struct {
	closes      atomic.Int32
	waits       atomic.Int32
	reads       atomic.Int32
	writes      atomic.Int32
	closeCalled chan struct{}
	exited      chan struct{}
	closeGate   chan struct{}
	closeErr    error
	waitErr     error
	autoExit    bool
	signalOnce  sync.Once
	exitOnce    sync.Once
}

func newClientCloseProcess() *clientCloseProcess {
	return &clientCloseProcess{closeCalled: make(chan struct{}), exited: make(chan struct{})}
}

func (p *clientCloseProcess) Read([]byte) (int, error) {
	p.reads.Add(1)
	return 0, io.ErrClosedPipe
}

func (p *clientCloseProcess) Write([]byte) (int, error) {
	p.writes.Add(1)
	return 0, io.ErrClosedPipe
}

func (p *clientCloseProcess) Close() error {
	p.closes.Add(1) // Count every original call, without fake idempotence.
	p.signalOnce.Do(func() { close(p.closeCalled) })
	if p.closeGate != nil {
		<-p.closeGate
	}
	if p.autoExit {
		p.exit()
	}
	return p.closeErr
}

func (p *clientCloseProcess) exit() { p.exitOnce.Do(func() { close(p.exited) }) }

func (p *clientCloseProcess) Wait(ctx context.Context) error {
	p.waits.Add(1)
	if p.waitErr != nil {
		return p.waitErr
	}
	select {
	case <-p.exited:
		return nil
	case <-ctx.Done():
		return task.ErrUnknown
	}
}

type clientCloseBoundary struct {
	selection Selection
	launches  atomic.Int32
	started   chan struct{}
	cancelled chan struct{}
	released  chan struct{}
	release   sync.Once
	process   Process
	launchErr error
}

func (b *clientCloseBoundary) Verify(ctx context.Context, s Selection) error {
	if ctx.Err() != nil || s != b.selection {
		return task.ErrIdentity
	}
	return nil
}

func (b *clientCloseBoundary) Launch(ctx context.Context, s Selection) (Process, error) {
	if s != b.selection {
		return nil, task.ErrIdentity
	}
	b.launches.Add(1)
	close(b.started)
	stop := context.AfterFunc(ctx, func() { close(b.cancelled) })
	defer stop()
	<-b.released // Deliberately ignore cancellation until the test releases Launch.
	return b.process, b.launchErr
}

func (b *clientCloseBoundary) releaseLaunch() { b.release.Do(func() { close(b.released) }) }

func newClientCloseFixture(t *testing.T, process Process) (*Client, *clientCloseBoundary) {
	t.Helper()
	s := testSelection()
	b := &clientCloseBoundary{selection: s, started: make(chan struct{}), cancelled: make(chan struct{}), released: make(chan struct{}), process: process}
	c, err := New(Options{Selection: s, Boundary: b, Now: func() time.Time { return s.GrantedAt.Add(time.Minute) }, Recheck: func(context.Context, task.Binding) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		b.releaseLaunch()
		_ = c.Close(context.Background())
	})
	return c, b
}

func clientCloseAwait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("controlled CPU lifetime did not reach its next boundary")
	}
}

func clientCloseError(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("controlled CPU call exceeded its bounded lifetime")
		return task.ErrUnknown
	}
}

func clientCloseStartRead(t *testing.T, c *Client, b *clientCloseBoundary) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		out, err := c.Observe(context.Background(), c.selection.Binding, completeRef())
		if err == nil || out.Result != "" {
			t.Error("closed original launch disclosed a history result")
			err = errors.New("closed original launch disclosed a history result")
		}
		done <- err
	}()
	clientCloseAwait(t, b.started)
	return done
}

func clientCloseAsync(c *Client, ctx context.Context) <-chan error {
	done := make(chan error, 1)
	go func() { done <- c.Close(ctx) }()
	return done
}

func assertClientCloseNoReplacement(t *testing.T, c *Client, b *clientCloseBoundary, p *clientCloseProcess, want error) {
	t.Helper()
	for i := 0; i < 3; i++ {
		err := c.Close(context.Background())
		if (want == nil && err != nil) || (want != nil && !errors.Is(err, want)) {
			t.Fatal("Close changed its retained result", err, want)
		}
		if _, err := c.Observe(context.Background(), c.selection.Binding, completeRef()); err == nil {
			t.Fatal("closed original admitted a new read")
		}
	}
	if b.launches.Load() != 1 || p.closes.Load() != 1 || p.waits.Load() != 1 || p.reads.Load() != 0 || p.writes.Load() != 0 {
		t.Fatal("cleanup relaunched, repeated termination/Wait or performed late IO", b.launches.Load(), p.closes.Load(), p.waits.Load(), p.reads.Load(), p.writes.Load())
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	owned, ok := c.connection.process.(*clientProcess)
	if !ok || owned.Process != p || !c.attempted || c.launching {
		t.Fatal("original child registration was lost or replaced")
	}
}

func TestClientCloseWaitsForOriginalLaunchRegistrationAndExit(t *testing.T) {
	p := newClientCloseProcess()
	c, b := newClientCloseFixture(t, p)
	t.Cleanup(p.exit)
	read := clientCloseStartRead(t, c, b)
	closed := clientCloseAsync(c, context.Background())
	clientCloseAwait(t, b.cancelled)
	select {
	case err := <-closed:
		t.Fatal("Close reported cleanup before Launch registered", err)
	default:
	}
	b.releaseLaunch()
	clientCloseAwait(t, p.closeCalled)
	select {
	case err := <-closed:
		t.Fatal("Close reported cleanup without exit proof", err)
	default:
	}
	p.exit()
	if err := clientCloseError(t, closed); err != nil {
		t.Fatal("proved original cleanup failed", err)
	}
	if err := clientCloseError(t, read); err == nil {
		t.Fatal("closed read succeeded")
	}
	assertClientCloseNoReplacement(t, c, b, p, nil)
}

func TestClientCloseConcurrentCallersShareOneOriginalCleanup(t *testing.T) {
	p := newClientCloseProcess()
	p.autoExit = true
	c, b := newClientCloseFixture(t, p)
	read := clientCloseStartRead(t, c, b)
	const count = 12
	closed := make([]<-chan error, count)
	for i := range closed {
		closed[i] = clientCloseAsync(c, context.Background())
	}
	clientCloseAwait(t, b.cancelled)
	b.releaseLaunch()
	for _, done := range closed {
		if err := clientCloseError(t, done); err != nil {
			t.Fatal("concurrent cleanup lost proof", err)
		}
	}
	_ = clientCloseError(t, read)
	assertClientCloseNoReplacement(t, c, b, p, nil)
}

func TestClientCloseBeforeStartPreventsOriginalLaunch(t *testing.T) {
	c, b := newClientCloseFixture(t, newClientCloseProcess())
	if err := c.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Close(ctx); err != nil {
		t.Fatal("completed inert cleanup lost to later cancellation", err)
	}
	if _, err := c.Observe(context.Background(), c.selection.Binding, completeRef()); err == nil {
		t.Fatal("Close before start allowed IO")
	}
	if b.launches.Load() != 0 || c.connection != nil || c.attempted {
		t.Fatal("closed lazy client started an original child")
	}
}

func TestClientCloseBlockedLaunchRetainsTimeoutAndOwnsLateChild(t *testing.T) {
	for _, mode := range []string{"deadline", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			p := newClientCloseProcess()
			p.autoExit = true
			c, b := newClientCloseFixture(t, p)
			read := clientCloseStartRead(t, c, b)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			if err := c.Close(ctx); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("unregistered original launch was declared closed", err)
			}
			if p.closes.Load() != 0 || p.waits.Load() != 0 {
				t.Fatal("cleanup invented a child before Launch returned")
			}
			b.releaseLaunch()
			clientCloseAwait(t, c.closeDone)
			_ = clientCloseError(t, read)
			assertClientCloseNoReplacement(t, c, b, p, task.ErrUnknown)
		})
	}
}

func TestClientCloseTwoSecondBudgetDoesNotRenewAfterLateRegistration(t *testing.T) {
	p := newClientCloseProcess()
	c, b := newClientCloseFixture(t, p)
	t.Cleanup(p.exit)
	read := clientCloseStartRead(t, c, b)
	started := time.Now()
	if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("blocked original launch passed cleanup", err)
	}
	if elapsed := time.Since(started); elapsed < 1800*time.Millisecond || elapsed > 3*time.Second {
		t.Fatal("Close did not keep its existing two-second bound", elapsed)
	}
	b.releaseLaunch()
	// The original child is still terminated once, but its exit collector must
	// receive the expired original budget, not another two-second allowance.
	clientCloseAwait(t, c.closeDone)
	_ = clientCloseError(t, read)
	assertClientCloseNoReplacement(t, c, b, p, task.ErrUnknown)
}

func TestClientCloseRetainsRefusedTerminationEvenWithProvedExit(t *testing.T) {
	p := newClientCloseProcess()
	p.closeErr, p.autoExit = errors.New("controlled termination refusal"), true
	c, b := newClientCloseFixture(t, p)
	read := clientCloseStartRead(t, c, b)
	closed := clientCloseAsync(c, context.Background())
	clientCloseAwait(t, b.cancelled)
	b.releaseLaunch()
	if err := clientCloseError(t, closed); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("proved exit erased refused termination", err)
	}
	clientCloseAwait(t, p.exited)
	_ = clientCloseError(t, read)
	assertClientCloseNoReplacement(t, c, b, p, task.ErrUnknown)
}

func TestClientCloseRetainsRefusalFromEarlierProxyFailure(t *testing.T) {
	p := newClientCloseProcess()
	p.closeErr, p.autoExit = errors.New("controlled earlier termination refusal"), true
	c, b := newClientCloseFixture(t, p)
	b.releaseLaunch()
	// Closed-pipe handshake fails before explicit Client.Close. proxy.fail must
	// preserve the termination refusal rather than let a later nil Wait erase it.
	if _, err := c.Observe(context.Background(), c.selection.Binding, completeRef()); err == nil {
		t.Fatal("controlled failed proxy was usable")
	}
	reads, writes := p.reads.Load(), p.writes.Load()
	for i := 0; i < 3; i++ {
		if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
			t.Fatal("earlier proxy failure lost its termination refusal", err)
		}
		_, _ = c.Observe(context.Background(), c.selection.Binding, completeRef())
	}
	if b.launches.Load() != 1 || p.closes.Load() != 1 || p.waits.Load() != 1 || p.reads.Load() != reads || p.writes.Load() != writes {
		t.Fatal("failed original proxy repeated cleanup, reconnected or performed new IO")
	}
}

func TestClientCloseRetainsMissingExitProof(t *testing.T) {
	p := newClientCloseProcess()
	p.waitErr = task.ErrUnknown
	c, b := newClientCloseFixture(t, p)
	read := clientCloseStartRead(t, c, b)
	closed := clientCloseAsync(c, context.Background())
	clientCloseAwait(t, b.cancelled)
	b.releaseLaunch()
	if err := clientCloseError(t, closed); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("missing exit proof passed cleanup", err)
	}
	_ = clientCloseError(t, read)
	assertClientCloseNoReplacement(t, c, b, p, task.ErrUnknown)
}

func TestClientCloseBlockedTerminationKeepsBoundAndOneAttempt(t *testing.T) {
	p := newClientCloseProcess()
	p.closeGate, p.autoExit = make(chan struct{}), true
	var release sync.Once
	unblock := func() { release.Do(func() { close(p.closeGate) }) }
	t.Cleanup(unblock)
	c, b := newClientCloseFixture(t, p)
	read := clientCloseStartRead(t, c, b)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	closed := clientCloseAsync(c, ctx)
	clientCloseAwait(t, b.cancelled)
	b.releaseLaunch()
	clientCloseAwait(t, p.closeCalled)
	if err := clientCloseError(t, closed); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("blocked termination passed cleanup", err)
	}
	if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) || p.closes.Load() != 1 {
		t.Fatal("unknown cleanup attempted termination again", err)
	}
	unblock()
	clientCloseAwait(t, c.closeDone)
	_ = clientCloseError(t, read)
	assertClientCloseNoReplacement(t, c, b, p, task.ErrUnknown)
}

func TestClientCloseFailedOriginalLaunchStaysUnknownWithoutReplacement(t *testing.T) {
	for _, mode := range []string{"error-no-child", "unknown-no-child", "missing-child", "error-with-child"} {
		t.Run(mode, func(t *testing.T) {
			p := newClientCloseProcess()
			p.autoExit = true
			var process Process
			if mode == "error-with-child" {
				process = p
			}
			c, b := newClientCloseFixture(t, process)
			switch mode {
			case "error-no-child":
				b.launchErr = task.ErrUnavailable
			case "unknown-no-child", "error-with-child":
				b.launchErr = task.ErrUnknown
			}
			b.releaseLaunch()
			if _, err := c.Observe(context.Background(), c.selection.Binding, completeRef()); err == nil {
				t.Fatal("failed original launch was usable")
			}
			if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("unproved original launch became known cleanup", err)
			}
			if process != nil {
				assertClientCloseNoReplacement(t, c, b, p, task.ErrUnknown)
			} else {
				for i := 0; i < 2; i++ {
					if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
						t.Fatal("failed launch uncertainty was erased", err)
					}
					_, _ = c.Observe(context.Background(), c.selection.Binding, completeRef())
				}
				if b.launches.Load() != 1 || c.connection != nil || p.closes.Load() != 0 || p.waits.Load() != 0 {
					t.Fatal("failed original was replaced or invented")
				}
			}
		})
	}
}

func TestClientCloseAuthorityCallbackDoesNotWaitOnReadGate(t *testing.T) {
	for _, phase := range []string{"before-launch", "after-history"} {
		for _, caller := range []string{"independent", "read-context"} {
			t.Run(phase+"/"+caller, func(t *testing.T) {
				s := testSelection()
				f := &pipeFixture{selection: s}
				f.valid.Store(true)
				var c *Client
				var invoked atomic.Bool
				callback := make(chan error, 1)
				check := func(ctx context.Context, _ task.Binding) error {
					if phase == "after-history" && len(f.seen("thread/items/list")) == 0 {
						return nil
					}
					if !invoked.Swap(true) {
						closeCtx := context.Background()
						if caller == "read-context" {
							closeCtx = ctx
						}
						callback <- c.Close(closeCtx)
					}
					return nil
				}
				var err error
				c, err = New(Options{Selection: s, Boundary: f, Now: func() time.Time { return s.GrantedAt.Add(time.Minute) }, Recheck: check})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = c.Close(context.Background()) })
				read := make(chan error, 1)
				go func() {
					out, err := c.Observe(context.Background(), s.Binding, completeRef())
					if err == nil || out.Result != "" {
						t.Error("authority callback Close disclosed late history")
						err = errors.New("authority callback Close disclosed late history")
					}
					read <- err
				}()
				closeErr := clientCloseError(t, callback)
				if (phase == "before-launch" || caller == "independent") && closeErr != nil {
					t.Fatal("authority callback lost available cleanup proof", closeErr)
				}
				if closeErr != nil && !errors.Is(closeErr, task.ErrUnknown) {
					t.Fatal("callback cleanup error was not classified", closeErr)
				}
				if err := clientCloseError(t, read); err == nil {
					t.Fatal("closed original read succeeded")
				}
				clientCloseAwait(t, c.closeDone)
				if err := c.Close(context.Background()); (closeErr == nil && err != nil) || (closeErr != nil && !errors.Is(err, task.ErrUnknown)) {
					t.Fatal("callback's retained cleanup outcome changed", err)
				}
				wantLaunch := int32(0)
				if phase == "after-history" {
					wantLaunch = 1
				}
				if f.launches.Load() != wantLaunch || f.closes.Load() != wantLaunch || len(f.seen("thread/start")) != 0 || len(f.seen("turn/start")) != 0 {
					t.Fatal("authority callback Close repeated or dispatched work")
				}
			})
		}
	}
}

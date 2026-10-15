package helperchannels

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Fixtures exclusively own disposable pipes/socketpairs. They prove Linux byte
// transport behavior, not trusted launch, application validation or Darwin IO.
func pipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	var fds [2]int
	if err := unix.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	unix.CloseOnExec(fds[0])
	unix.CloseOnExec(fds[1])
	// Like inherited handles, these blocking files lack Go poller registration.
	r, w := os.NewFile(uintptr(fds[0]), "owned-pipe-read"), os.NewFile(uintptr(fds[1]), "owned-pipe-write")
	t.Cleanup(func() { _ = r.Close(); _ = w.Close() })
	return r, w
}

func socketPair(t *testing.T, kind int) (*os.File, *os.File) {
	t.Helper()
	fds, err := unix.Socketpair(unix.AF_UNIX, kind, 0)
	if errors.Is(err, unix.EPROTONOSUPPORT) {
		t.Skip("this host has no AF_UNIX socket of this type")
	}
	if err != nil {
		t.Fatal(err)
	}
	unix.CloseOnExec(fds[0])
	unix.CloseOnExec(fds[1])
	a, b := os.NewFile(uintptr(fds[0]), "owned-socket-a"), os.NewFile(uintptr(fds[1]), "owned-socket-b")
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return a, b
}

func take(t *testing.T, ack, cont *os.File) *Channels {
	t.Helper()
	c, err := Take(ack, cont)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func outcome(t *testing.T, err error, code string, uncertain bool) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != "helper_channels_"+code || f.Uncertain != uncertain {
		t.Fatalf("got %#v, want %s uncertain=%v", err, code, uncertain)
	}
}

func closed(t *testing.T, f *os.File) {
	t.Helper()
	if _, err := f.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("transferred owner not closed: %v", err)
	}
}

func TestPipesOpaqueFramesAndEOF(t *testing.T) {
	ar, aw := pipe(t)
	cr, cw := pipe(t)
	c := take(t, aw, cr)
	ack := []byte{0, 0xff, '\n', '{'}
	if err := c.Emit(context.Background(), time.Now().Add(time.Second), ack); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(ar)
	if err != nil || !bytes.Equal(got, ack) {
		t.Fatalf("ACK %x %v", got, err)
	}
	closed(t, aw)
	cont := bytes.Repeat([]byte{0xff}, maxFrame)
	if _, err := cw.Write(cont); err != nil {
		t.Fatal(err)
	}
	_ = cw.Close()
	got, err = c.AwaitContinue(context.Background(), time.Now().Add(time.Second))
	if err != nil || !bytes.Equal(got, cont) {
		t.Fatalf("continuation len=%d %v", len(got), err)
	}
	closed(t, cr)
	outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), ack), "ack_used", true)
	_, err = c.AwaitContinue(context.Background(), time.Now().Add(time.Second))
	outcome(t, err, "continue_used", false)
}

func TestStreamSocketsAndLinger(t *testing.T) {
	a, peer := socketPair(t, unix.SOCK_STREAM)
	b, producer := socketPair(t, unix.SOCK_STREAM)
	raw, _ := a.SyscallConn()
	var setErr error
	if err := raw.Control(func(fd uintptr) {
		setErr = unix.SetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER, &unix.Linger{Onoff: 1, Linger: 30})
	}); err != nil || setErr != nil {
		t.Fatalf("set linger %v %v", err, setErr)
	}
	c := take(t, a, b)
	var linger *unix.Linger
	_ = raw.Control(func(fd uintptr) { linger, setErr = unix.GetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER) })
	if setErr != nil || linger.Onoff != 0 {
		t.Fatalf("linger not disabled: %v %v", linger, setErr)
	}
	if err := c.Emit(context.Background(), time.Now().Add(time.Second), []byte("ack")); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(peer)
	if err != nil || string(got) != "ack" {
		t.Fatalf("ACK %q %v", got, err)
	}
	_, _ = producer.Write([]byte("continue"))
	_ = producer.Close()
	got, err = c.AwaitContinue(context.Background(), time.Now().Add(time.Second))
	if err != nil || string(got) != "continue" {
		t.Fatalf("continuation %q %v", got, err)
	}
}

func TestConstructorConsumesOnFailure(t *testing.T) {
	t.Run("missing ACK", func(t *testing.T) {
		r, _ := pipe(t)
		_, err := Take(nil, r)
		outcome(t, err, "ack_required", false)
		closed(t, r)
	})
	t.Run("same pointer", func(t *testing.T) {
		_, w := pipe(t)
		_, err := Take(w, w)
		outcome(t, err, "alias", false)
		closed(t, w)
	})
	t.Run("regular file untouched", func(t *testing.T) {
		f, err := os.CreateTemp(t.TempDir(), "regular")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.WriteString("preserve")
		name := f.Name()
		r, _ := pipe(t)
		_, err = Take(f, r)
		outcome(t, err, "ack_channel", false)
		closed(t, f)
		closed(t, r)
		data, err := os.ReadFile(name)
		if err != nil || string(data) != "preserve" {
			t.Fatalf("regular changed %q %v", data, err)
		}
	})
	for _, which := range []string{"ack", "continue"} {
		t.Run("wrong direction "+which, func(t *testing.T) {
			ar, aw := pipe(t)
			cr, cw := pipe(t)
			a, b := aw, cr
			if which == "ack" {
				a = ar
			} else {
				b = cw
			}
			_, err := Take(a, b)
			outcome(t, err, which+"_channel", false)
			closed(t, a)
			closed(t, b)
		})
	}
	for _, kind := range []int{unix.SOCK_DGRAM, unix.SOCK_SEQPACKET} {
		t.Run("nonstream", func(t *testing.T) {
			a, _ := socketPair(t, kind)
			_, err := Take(a, nil)
			outcome(t, err, "ack_channel", false)
			closed(t, a)
		})
	}
	t.Run("already closed uncertainty", func(t *testing.T) {
		_, w := pipe(t)
		_ = w.Close()
		_, err := Take(w, nil)
		outcome(t, err, "ack_channel", true)
	})
}

func TestContinueRequiresBoundedNonemptyEOF(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
		seal bool
		want string
	}{
		{"empty", 0, true, "continue_empty"},
		{"overflow", maxFrame + 1, false, "continue_size"},
		{"withheld EOF", maxFrame, false, "deadline"},
		{"no data", 0, false, "deadline"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, aw := pipe(t)
			cr, cw := pipe(t)
			c := take(t, aw, cr)
			if tc.size > 0 {
				if _, err := cw.Write(bytes.Repeat([]byte{'x'}, tc.size)); err != nil {
					t.Fatal(err)
				}
			}
			if tc.seal {
				_ = cw.Close()
			}
			start := time.Now()
			got, err := c.AwaitContinue(context.Background(), start.Add(30*time.Millisecond))
			outcome(t, err, tc.want, false)
			if got != nil || time.Since(start) > time.Second {
				t.Fatalf("unbounded or exposed bytes: %d", len(got))
			}
			closed(t, cr)
		})
	}
}

func TestInvalidEmitConsumesAttempt(t *testing.T) {
	for _, size := range []int{0, maxFrame + 1} {
		ar, aw := pipe(t)
		c := take(t, aw, nil)
		outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), make([]byte, size)), "ack_size", false)
		got, err := io.ReadAll(ar)
		if err != nil || len(got) != 0 {
			t.Fatalf("invalid write: %x %v", got, err)
		}
		outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), []byte("retry")), "ack_used", false)
	}
}

func TestBoundsAndCancellationBeforeEffect(t *testing.T) {
	for _, mode := range []string{"zero", "nil context", "expired", "cancelled", "context deadline"} {
		t.Run(mode, func(t *testing.T) {
			ar, aw := pipe(t)
			cr, _ := pipe(t)
			c := take(t, aw, cr)
			ctx := context.Background()
			until := time.Now().Add(time.Second)
			want := "deadline"
			switch mode {
			case "zero":
				until = time.Time{}
				want = "bounds"
			case "nil context":
				ctx = nil
				want = "bounds"
			case "expired":
				until = time.Now().Add(-time.Second)
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
				want = "cancelled"
			case "context deadline":
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer cancel()
			}
			outcome(t, c.Emit(ctx, until, []byte("ack")), want, false)
			got, err := io.ReadAll(ar)
			if err != nil || len(got) != 0 {
				t.Fatalf("preflight wrote: %x %v", got, err)
			}
			_, err = c.AwaitContinue(ctx, until)
			outcome(t, err, want, false)
			closed(t, cr)
		})
	}
}

// Fill an owned pipe/socket without depending on Go poller registration.
func fill(t *testing.T, f *os.File) {
	t.Helper()
	raw, err := f.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var nativeErr error
	err = raw.Control(func(fd uintptr) {
		if nativeErr = unix.SetNonblock(int(fd), true); nativeErr != nil {
			return
		}
		for {
			_, nativeErr = unix.Write(int(fd), make([]byte, maxFrame))
			if nativeErr != nil {
				return
			}
		}
	})
	if err != nil || !errors.Is(nativeErr, unix.EAGAIN) {
		t.Fatalf("fill %v %v", err, nativeErr)
	}
}

func TestBackpressureCancellationAndCloseJoin(t *testing.T) {
	for _, mode := range []string{"absolute", "context deadline", "cancel", "close"} {
		t.Run(mode, func(t *testing.T) {
			_, aw := pipe(t)
			cr, _ := pipe(t)
			fill(t, aw)
			c := take(t, aw, cr)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			until := time.Now().Add(time.Second)
			if mode == "absolute" {
				until = time.Now().Add(30 * time.Millisecond)
			}
			if mode == "context deadline" {
				var stop context.CancelFunc
				ctx, stop = context.WithTimeout(ctx, 30*time.Millisecond)
				defer stop()
			}
			ackResult := make(chan error, 1)
			contResult := make(chan error, 1)
			go func() { ackResult <- c.Emit(ctx, until, []byte("ack")) }()
			go func() { _, err := c.AwaitContinue(ctx, until); contResult <- err }()
			waitActive(t, c)
			outcome(t, c.Emit(ctx, until, []byte("duplicate")), "ack_used", true)
			_, err := c.AwaitContinue(ctx, until)
			outcome(t, err, "continue_used", false)
			want := "deadline"
			if mode == "cancel" {
				cancel()
				want = "cancelled"
			}
			if mode == "close" {
				if err := c.Close(); err != nil {
					t.Fatal(err)
				}
				want = "closed"
			}
			select {
			case err := <-ackResult:
				outcome(t, err, want, false)
			case <-time.After(time.Second):
				t.Fatal("ACK did not join")
			}
			select {
			case err := <-contResult:
				outcome(t, err, want, false)
			case <-time.After(time.Second):
				t.Fatal("continuation did not join")
			}
			closed(t, aw)
			closed(t, cr)
		})
	}
}

func waitActive(t *testing.T, c *Channels) {
	t.Helper()
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		c.state.mu.Lock()
		ready := c.state.ackUsed && c.state.contUsed
		c.state.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("operations did not start")
}

func TestLateWriteAndEOFNeverSucceed(t *testing.T) {
	for _, mode := range []string{"write", "eof", "ack_close"} {
		t.Run(mode, func(t *testing.T) {
			ar, aw := pipe(t)
			cr, cw := pipe(t)
			c := take(t, aw, cr)
			_, _ = cw.Write([]byte("continue"))
			_ = cw.Close()
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			c.state.afterIO = func(point string) {
				if point == mode {
					once.Do(func() { close(entered); <-release })
				}
			}
			until := time.Now().Add(100 * time.Millisecond)
			result := make(chan error, 1)
			go func() {
				if mode != "eof" {
					result <- c.Emit(context.Background(), until, []byte("ack"))
					return
				}
				got, err := c.AwaitContinue(context.Background(), until)
				if got != nil {
					result <- errors.New("late frame exposed")
					return
				}
				result <- err
			}()
			select {
			case <-entered:
			case err := <-result:
				t.Fatalf("operation never reached native result: %v", err)
			case <-time.After(time.Second):
				close(release)
				t.Fatal("operation did not reach test hook")
			}
			<-time.After(time.Until(until) + time.Millisecond)
			close(release)
			outcome(t, <-result, "deadline", mode != "eof")
			if mode != "eof" {
				got, err := io.ReadAll(ar)
				if err != nil || string(got) != "ack" {
					t.Fatalf("late ACK %q %v", got, err)
				}
				outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), []byte("retry")), "ack_used", true)
			}
		})
	}
}

func TestACKCloseFailureStaysUncertain(t *testing.T) {
	_, aw := pipe(t)
	c := take(t, aw, nil)
	c.state.afterIO = func(point string) {
		if point == "write" {
			// Inject a lost close result after closing the exact owner. No detached
			// fd is closed, and production has no hook.
			c.state.ack.once.Do(func() { _ = c.state.ack.file.Close(); c.state.ack.err = unix.EIO })
		}
	}
	outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), []byte("ack")), "ack_close", true)
	outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), []byte("retry")), "ack_used", true)
	outcome(t, c.Close(), "ack_close", true)
	outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), []byte("retry")), "closed", true)
}

func TestConcurrentOneShotAndClose(t *testing.T) {
	ar, aw := pipe(t)
	c := take(t, aw, nil)
	const callers = 16
	results := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Go(func() { results <- c.Emit(context.Background(), time.Now().Add(time.Second), []byte("ack")) })
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else {
			outcome(t, err, "ack_used", true)
		}
	}
	if success != 1 {
		t.Fatalf("successful attempts %d", success)
	}
	got, err := io.ReadAll(ar)
	if err != nil || string(got) != "ack" {
		t.Fatalf("multiple frames %q %v", got, err)
	}
	for range callers {
		wg.Go(func() {
			if err := c.Close(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	outcome(t, c.Emit(context.Background(), time.Now().Add(time.Second), []byte("retry")), "closed", true)
	_, err = c.AwaitContinue(context.Background(), time.Now().Add(time.Second))
	outcome(t, err, "closed", false)
}

func TestOptionalContinueAndCloseUnused(t *testing.T) {
	ar, aw := pipe(t)
	c := take(t, aw, nil)
	_, err := c.AwaitContinue(context.Background(), time.Now().Add(time.Second))
	outcome(t, err, "continue_missing", false)
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(ar)
	if err != nil || len(got) != 0 {
		t.Fatalf("close unused %x %v", got, err)
	}
	closed(t, aw)
}

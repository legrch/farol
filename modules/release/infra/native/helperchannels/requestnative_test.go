package helperchannels

import (
	"bytes"
	"context"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Fresh, uniquely owned native pipes/socketpairs exercise this host's byte IO.
// They do not qualify helper launch, admission, custody, CLI selection or effects.
func requestStream(t *testing.T, kind string) (*os.File, *os.File) {
	t.Helper()
	if kind == "pipe" {
		return pipe(t)
	}
	return socketPair(t, unix.SOCK_STREAM)
}

func takeRequest(t *testing.T, file *os.File) *Request {
	t.Helper()
	r, err := TakeRequest(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r
}

// Feed concurrently: a fresh host stream may hold fewer than 8193 bytes. The
// test producer also uses bounded native IO and is always joined by cleanup.
func feedRequest(t *testing.T, producer *os.File, data []byte, seal bool) func() {
	t.Helper()
	raw, err := producer.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var nativeErr error
	if err := raw.Control(func(fd uintptr) { nativeErr = unix.SetNonblock(int(fd), true) }); err != nil || nativeErr != nil {
		t.Fatalf("configure test producer %v %v", err, nativeErr)
	}
	done, stop := make(chan struct{}), make(chan struct{})
	var writeErr error
	go func() {
		defer close(done)
		until := time.Now().Add(time.Second)
		for offset := 0; offset < len(data); {
			var n int
			var nativeErr error
			err := raw.Control(func(fd uintptr) { n, nativeErr = unix.Write(int(fd), data[offset:]) })
			if err != nil {
				writeErr = err
				return
			}
			if nativeErr != nil && !retryable(nativeErr) {
				writeErr = nativeErr
				return
			}
			if n > 0 {
				offset += n
				continue
			}
			if !time.Now().Before(until) {
				writeErr = context.DeadlineExceeded
				return
			}
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
			}
		}
		if seal {
			writeErr = producer.Close()
		}
	}()
	t.Cleanup(func() { close(stop); <-done })
	return func() {
		t.Helper()
		<-done
		if writeErr != nil {
			t.Fatalf("feed request %v", writeErr)
		}
	}
}

func TestRequestNativeBoundsAndEOF(t *testing.T) {
	for _, kind := range []string{"pipe", "socket"} {
		for _, size := range []int{0, 1, 4097, 8192, 8193} {
			t.Run(kind+"/"+strconv.Itoa(size), func(t *testing.T) {
				input, producer := requestStream(t, kind)
				r := takeRequest(t, input)
				want := bytes.Repeat([]byte{0xff}, size)
				join := feedRequest(t, producer, want, true)
				data, err := r.Read(context.Background(), time.Now().Add(time.Second))
				join()
				switch size {
				case 0:
					requestFailed(t, requestResult{data, err}, "empty")
				case 8193:
					requestFailed(t, requestResult{data, err}, "size")
				default:
					if err != nil || !bytes.Equal(data, want) {
						t.Fatalf("request len=%d err=%v", len(data), err)
					}
				}
				closed(t, input)
				data, err = r.Read(context.Background(), time.Now().Add(time.Second))
				requestFailed(t, requestResult{data, err}, "used")
			})
		}
	}
}

func TestRequestNativeWithheldEOFAndOverflow(t *testing.T) {
	for _, kind := range []string{"pipe", "socket"} {
		for _, size := range []int{0, 8192, 8193} {
			t.Run(kind+"/"+strconv.Itoa(size), func(t *testing.T) {
				input, producer := requestStream(t, kind)
				r := takeRequest(t, input)
				join := feedRequest(t, producer, bytes.Repeat([]byte{'x'}, size), false)
				start := time.Now()
				until := start.Add(40 * time.Millisecond)
				data, err := r.Read(context.Background(), until)
				join()
				want := "deadline"
				if size > 8192 {
					want = "size"
				} else if time.Now().Before(until) {
					t.Fatal("accepted missing EOF before the boundary")
				}
				requestFailed(t, requestResult{data, err}, want)
				if time.Since(start) > time.Second {
					t.Fatal("native read was not bounded")
				}
				closed(t, input)
				data, err = r.Read(context.Background(), time.Now().Add(time.Second))
				requestFailed(t, requestResult{data, err}, "used")
			})
		}
	}
}

func TestRequestNativeRejectsAndConsumesDescriptors(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		r, err := TakeRequest(nil)
		outcome(t, err, "request_required", false)
		if r != nil {
			t.Fatal("nil descriptor produced an owner")
		}
	})
	for _, mode := range []string{"write pipe", "regular", "directory", "closed", "datagram", "seqpacket"} {
		t.Run(mode, func(t *testing.T) {
			var file *os.File
			var name string
			switch mode {
			case "write pipe":
				_, file = pipe(t)
			case "regular":
				var err error
				file, err = os.CreateTemp(t.TempDir(), "request-private-name")
				if err != nil {
					t.Fatal(err)
				}
				name = file.Name()
				if _, err := file.WriteString("preserve"); err != nil {
					t.Fatal(err)
				}
			case "directory":
				var err error
				file, err = os.Open(t.TempDir())
				if err != nil {
					t.Fatal(err)
				}
			case "closed":
				file, _ = pipe(t)
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			case "datagram":
				file, _ = socketPair(t, unix.SOCK_DGRAM)
			case "seqpacket":
				file, _ = socketPair(t, unix.SOCK_SEQPACKET)
			}
			r, err := TakeRequest(file)
			outcome(t, err, "request_channel", mode == "closed")
			if err.Error() != "helper_channels_request_channel" || r != nil {
				t.Fatalf("unclassified result %v %v", r, err)
			}
			closed(t, file)
			if name != "" {
				data, err := os.ReadFile(name)
				if err != nil || string(data) != "preserve" {
					t.Fatalf("regular file changed: %q %v", data, err)
				}
			}
		})
	}
}

func TestRequestNativeConfiguresOnlyOwnedStream(t *testing.T) {
	for _, kind := range []string{"pipe", "socket"} {
		t.Run(kind, func(t *testing.T) {
			input, producer := requestStream(t, kind)
			raw, err := input.SyscallConn()
			if err != nil {
				t.Fatal(err)
			}
			if kind == "socket" {
				var setErr error
				err := raw.Control(func(fd uintptr) {
					setErr = unix.SetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER, &unix.Linger{Onoff: 1, Linger: 30})
				})
				if err != nil || setErr != nil {
					t.Fatalf("set linger %v %v", err, setErr)
				}
			}
			r := takeRequest(t, input)
			var flags int
			var nativeErr error
			err = raw.Control(func(fd uintptr) {
				flags, nativeErr = unix.FcntlInt(fd, unix.F_GETFL, 0)
				if nativeErr == nil && kind == "socket" {
					var linger *unix.Linger
					linger, nativeErr = unix.GetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER)
					if nativeErr == nil && linger.Onoff != 0 {
						nativeErr = unix.EINVAL
					}
				}
			})
			if err != nil || nativeErr != nil || flags&unix.O_NONBLOCK == 0 {
				t.Fatalf("nonblocking/linger configuration %x %v %v", flags, err, nativeErr)
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			closed(t, input)
			if _, err := producer.Stat(); err != nil {
				t.Fatalf("peer was closed: %v", err)
			}
			data, err := r.Read(context.Background(), time.Now().Add(time.Second))
			requestFailed(t, requestResult{data, err}, "closed")
		})
	}
}

func TestRequestNativeCancellationAndClose(t *testing.T) {
	for _, kind := range []string{"pipe", "socket"} {
		for _, mode := range []string{"cancel", "context deadline", "close"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				input, producer := requestStream(t, kind)
				r := takeRequest(t, input)
				copy := *r
				if _, err := producer.Write([]byte("partial")); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if mode == "context deadline" {
					var stop context.CancelFunc
					ctx, stop = context.WithTimeout(ctx, 80*time.Millisecond)
					defer stop()
				}
				entered := make(chan struct{})
				var once sync.Once
				r.state.afterIO = func(point string) {
					if point == "read" {
						once.Do(func() { close(entered) })
					}
				}
				results := make(chan requestResult, 1)
				go func() {
					data, err := r.Read(ctx, time.Now().Add(time.Second))
					results <- requestResult{data, err}
				}()
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("native read did not start")
				}
				data, err := copy.Read(context.Background(), time.Now().Add(time.Second))
				requestFailed(t, requestResult{data, err}, "used")
				want := "deadline"
				if mode == "cancel" {
					cancel()
					want = "cancelled"
				}
				if mode == "close" {
					var wg sync.WaitGroup
					for range 16 {
						wg.Go(func() {
							if err := copy.Close(); err != nil {
								t.Error(err)
							}
						})
					}
					wg.Wait()
					want = "closed"
				}
				requestFailed(t, receiveRequest(t, results), want)
				closed(t, input)
				data, err = copy.Read(context.Background(), time.Now().Add(time.Second))
				if mode == "close" {
					requestFailed(t, requestResult{data, err}, "closed")
				} else {
					requestFailed(t, requestResult{data, err}, "used")
				}
			})
		}
	}
}

// A context whose timer delivery is withheld models a delayed timer goroutine.
// Boundary checks must use Deadline even while Done/Err have not changed.
type requestDelayedDeadline struct {
	context.Context
	until time.Time
}

func (c requestDelayedDeadline) Deadline() (time.Time, bool) { return c.until, true }

func TestRequestNativeLateResultsAndPreIOBoundary(t *testing.T) {
	for _, boundary := range []string{"absolute", "context", "cancel"} {
		for _, point := range []string{"before", "read", "eof", "close"} {
			t.Run(boundary+"/"+point, func(t *testing.T) {
				input, producer := pipe(t)
				r := takeRequest(t, input)
				if _, err := producer.Write([]byte("ready")); err != nil {
					t.Fatal(err)
				}
				if err := producer.Close(); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				deadline := time.Now().Add(60 * time.Millisecond)
				until := deadline
				if boundary != "absolute" {
					until = time.Now().Add(time.Second)
				}
				if boundary == "context" {
					ctx = requestDelayedDeadline{context.Background(), deadline}
				}
				entered, release := make(chan struct{}), make(chan struct{})
				var releaseOnce, hookOnce sync.Once
				unblock := func() { releaseOnce.Do(func() { close(release) }) }
				defer unblock()
				block := func() { hookOnce.Do(func() { close(entered); <-release }) }
				if point == "before" {
					r.state.beforeIO = block
				} else {
					r.state.afterIO = func(got string) {
						if got == point {
							block()
						}
					}
				}
				nativeResults := 0
				if point == "before" {
					r.state.afterIO = func(got string) {
						if got != "close" {
							nativeResults++
						}
					}
				}
				results := make(chan requestResult, 1)
				go func() {
					data, err := r.Read(ctx, until)
					results <- requestResult{data, err}
				}()
				select {
				case <-entered:
				case got := <-results:
					t.Fatalf("missed native boundary: %v", got.err)
				case <-time.After(time.Second):
					t.Fatal("native boundary not reached")
				}
				want := "deadline"
				if boundary == "cancel" {
					cancel()
					want = "cancelled"
				} else {
					time.Sleep(max(time.Until(deadline), 0) + time.Millisecond)
				}
				unblock()
				requestFailed(t, receiveRequest(t, results), want)
				if point == "before" && nativeResults != 0 {
					t.Fatal("native read ran after its boundary")
				}
				closed(t, input)
				data, err := r.Read(context.Background(), time.Now().Add(time.Second))
				requestFailed(t, requestResult{data, err}, "used")
			})
		}
	}
}

func TestRequestNativeCloseJoinsRetainedCall(t *testing.T) {
	input, _ := socketPair(t, unix.SOCK_STREAM)
	r := takeRequest(t, input)
	copy := *r
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	r.state.beforeIO = func() { close(entered); <-release }
	results := make(chan requestResult, 1)
	go func() {
		data, err := r.Read(context.Background(), time.Now().Add(time.Second))
		results <- requestResult{data, err}
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("retained call not entered")
	}
	closeResult := make(chan error, 1)
	go func() { closeResult <- copy.Close() }()
	select {
	case <-r.state.stop:
	case <-time.After(time.Second):
		t.Fatal("close did not cancel active read")
	}
	select {
	case err := <-closeResult:
		t.Fatalf("close detached retained call: %v", err)
	default:
	}
	if _, err := input.Stat(); err != nil {
		t.Fatalf("retained descriptor closed while Control active: %v", err)
	}
	unblock()
	requestFailed(t, receiveRequest(t, results), "closed")
	select {
	case err := <-closeResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not join retained call")
	}
	closed(t, input)
}

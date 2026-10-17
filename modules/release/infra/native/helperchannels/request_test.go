package helperchannels

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type requestResult struct {
	data []byte
	err  error
}

func requestFailed(t *testing.T, result requestResult, code string) {
	t.Helper()
	outcome(t, result.err, "request_"+code, false)
	if result.data != nil {
		t.Fatalf("failed request exposed %d bytes", len(result.data))
	}
}

func receiveRequest(t *testing.T, result <-chan requestResult) requestResult {
	t.Helper()
	select {
	case got := <-result:
		return got
	case <-time.After(time.Second):
		t.Fatal("request read did not join")
		return requestResult{}
	}
}

func TestRequestNilAndZeroFailClosed(t *testing.T) {
	var missing *Request
	var zero Request
	copy := zero
	for _, r := range []*Request{missing, &zero, &copy} {
		data, err := r.Read(context.Background(), time.Now().Add(time.Second))
		requestFailed(t, requestResult{data, err}, "closed")
		outcome(t, r.Close(), "request_closed", false)
	}
}

func TestRequestInvalidReadConsumesAttempt(t *testing.T) {
	for _, mode := range []string{"nil context", "zero deadline", "expired", "cancelled", "context expired"} {
		t.Run(mode, func(t *testing.T) {
			input, producer := pipe(t)
			r := takeRequest(t, input)
			copy := *r
			if _, err := producer.Write([]byte("ready")); err != nil {
				t.Fatal(err)
			}
			if err := producer.Close(); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			until := time.Now().Add(time.Second)
			want := "deadline"
			switch mode {
			case "nil context":
				ctx, want = nil, "bounds"
			case "zero deadline":
				until, want = time.Time{}, "bounds"
			case "expired":
				until = time.Now().Add(-time.Second)
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
				want = "cancelled"
			case "context expired":
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer cancel()
			}
			calls := 0
			r.state.beforeIO = func() { calls++ }
			data, err := r.Read(ctx, until)
			requestFailed(t, requestResult{data, err}, want)
			if calls != 0 {
				t.Fatal("invalid read reached native IO")
			}
			closed(t, input)
			data, err = copy.Read(context.Background(), time.Now().Add(time.Second))
			requestFailed(t, requestResult{data, err}, "used")
		})
	}
}

func TestRequestCopiesShareOneAttempt(t *testing.T) {
	input, producer := pipe(t)
	r := takeRequest(t, input)
	want := []byte{0, 0xff, '{', '\n'}
	if _, err := producer.Write(want); err != nil {
		t.Fatal(err)
	}
	if err := producer.Close(); err != nil {
		t.Fatal(err)
	}
	const callers = 16
	wrappers := make([]Request, callers)
	for i := range wrappers {
		wrappers[i] = *r
	}
	start := make(chan struct{})
	results := make(chan requestResult, callers)
	until := time.Now().Add(time.Second)
	var wg sync.WaitGroup
	for i := range wrappers {
		wg.Go(func() {
			<-start
			data, err := wrappers[i].Read(context.Background(), until)
			results <- requestResult{data, err}
		})
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for got := range results {
		if got.err != nil {
			requestFailed(t, got, "used")
			continue
		}
		successes++
		if !bytes.Equal(got.data, want) {
			t.Fatalf("request bytes %x", got.data)
		}
	}
	if successes != 1 {
		t.Fatalf("successful reads: %d", successes)
	}
	for i := range wrappers {
		wg.Go(func() {
			if err := wrappers[i].Close(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	closed(t, input)
	for i := range wrappers {
		data, err := wrappers[i].Read(context.Background(), time.Now().Add(time.Second))
		requestFailed(t, requestResult{data, err}, "closed")
		if err := wrappers[i].Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRequestCloseFailureDiscardsCompleteBytes(t *testing.T) {
	input, producer := pipe(t)
	r := takeRequest(t, input)
	if _, err := producer.Write([]byte("complete")); err != nil {
		t.Fatal(err)
	}
	if err := producer.Close(); err != nil {
		t.Fatal(err)
	}
	r.state.afterIO = func(point string) {
		if point == "eof" {
			// Lost close receipt after closing the exact owner. No fd-number
			// cleanup or production injection surface is involved.
			r.state.input.once.Do(func() {
				_ = r.state.input.file.Close()
				r.state.input.err = unix.EIO
			})
		}
	}
	data, err := r.Read(context.Background(), time.Now().Add(time.Second))
	requestFailed(t, requestResult{data, err}, "close")
	closed(t, input)
	data, err = r.Read(context.Background(), time.Now().Add(time.Second))
	requestFailed(t, requestResult{data, err}, "used")
	for range 2 {
		outcome(t, r.Close(), "request_close", false)
	}
}

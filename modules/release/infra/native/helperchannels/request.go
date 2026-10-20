package helperchannels

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"
)

const maxRequest = 8192

// Request owns a single inherited request byte stream. Copies share the same
// private one-shot state. It grants no launch, peer, JSON or application authority.
type Request struct {
	state *requestState
}

type requestState struct {
	mu        sync.Mutex
	input     *owned
	used      bool
	closed    bool
	stop      chan struct{}
	active    sync.WaitGroup
	closeOnce sync.Once
	closeErr  error
	terminal  error
	// Deterministic native-boundary tests only; nil in production.
	beforeIO func()
	afterIO  func(string)
}

func requestFailure(code string, uncertain bool, causes ...error) error {
	return failure("request_"+code, uncertain, causes...)
}

// TakeRequest transfers exclusive ownership of file ON CALL, including failure.
// The caller must supply a unique open-file description, without dup aliases or
// other os.File wrappers, and never use it again. It must not be shared with a
// lease, ACK or continuation channel. Native metadata cannot prove uniqueness
// or peer trust. No descriptor-number discovery or role binding is performed.
//
// Only read-end pipes and stream sockets are accepted. Owned O_NONBLOCK is
// enabled and socket SO_LINGER disabled so native reads and cleanup are bounded.
// FD_CLOEXEC is added so no exec'd child inherits the request; failure refuses
// before any read.
func TakeRequest(file *os.File) (*Request, error) {
	if file == nil {
		return nil, requestFailure("required", false)
	}
	o := &owned{file: file}
	if err := configure(o, false); err != nil {
		prepareErr := prepareClose(file)
		closeErr := o.close()
		f := requestFailure("channel", closeErr != nil, err, prepareErr, closeErr).(*Failure)
		f.CleanupUnconfirmed = closeErr != nil
		return nil, f
	}
	return &Request{state: &requestState{input: o, stop: make(chan struct{})}}, nil
}

func (r *requestState) begin() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return requestFailure("closed", false, r.terminal)
	}
	if r.used {
		return requestFailure("used", false, r.terminal)
	}
	r.used = true
	r.active.Add(1)
	return nil
}

func (r *requestState) guard(ctx context.Context, until time.Time) string {
	if ctx == nil || until.IsZero() {
		return "bounds"
	}
	select {
	case <-r.stop:
		return "closed"
	default:
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "deadline"
	}
	if ctx.Err() != nil {
		return "cancelled"
	}
	now := time.Now()
	if !now.Before(until) {
		return "deadline"
	}
	// Check the actual earlier boundary even if its timer has not run yet.
	if deadline, ok := ctx.Deadline(); ok && !now.Before(deadline) {
		return "deadline"
	}
	return ""
}

func (r *requestState) pause(ctx context.Context, until time.Time) {
	delay := min(pollInterval, time.Until(until))
	if deadline, ok := ctx.Deadline(); ok {
		delay = min(delay, time.Until(deadline))
	}
	timer := time.NewTimer(max(delay, 0))
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-r.stop:
	case <-timer.C:
	}
}

// Read consumes the one attempt, including invalid or cancelled calls, and
// returns only 1..8192 opaque bytes sealed by EOF within originalUntil and any
// earlier context boundary. The attempt always closes its retained owner, and
// every failure returns nil bytes. No failure permits rearming with fresh bounds.
func (r *Request) Read(ctx context.Context, originalUntil time.Time) ([]byte, error) {
	if r == nil || r.state == nil {
		return nil, requestFailure("closed", false)
	}
	return r.state.read(ctx, originalUntil)
}

func (r *requestState) read(ctx context.Context, until time.Time) (data []byte, err error) {
	if err = r.begin(); err != nil {
		return nil, err
	}
	defer r.active.Done()
	defer func() {
		err = retainBounds(err, requestGuardCode(r.guard(ctx, until)), false, ctx, until)
		// Cleanup is mandatory even after the original bounds expire.
		if closeErr := r.input.close(); closeErr != nil {
			err = cleanupFailure("request_close", false, err, closeErr)
		}
		if r.afterIO != nil {
			r.afterIO("close")
		}
		err = retainBounds(err, requestGuardCode(r.guard(ctx, until)), false, ctx, until)
		if err != nil {
			data = nil
		}
		r.mu.Lock()
		r.terminal = err
		r.mu.Unlock()
	}()
	var buffer [maxRequest + 1]byte
	size := 0
	var lastErr error
	for {
		if code := r.guard(ctx, until); code != "" {
			return nil, requestFailure(code, false, lastErr, boundCauses(ctx, until))
		}
		var n int
		var nativeErr error
		attempted := false
		// Control retains the exact owned descriptor through the actual
		// nonblocking syscall. There is no detached syscall goroutine.
		controlErr := r.input.raw.Control(func(fd uintptr) {
			if r.beforeIO != nil {
				r.beforeIO()
			}
			if r.guard(ctx, until) == "" {
				attempted = true
				n, nativeErr = r.input.readBytes(int(fd), buffer[size:])
			}
		})
		lastErr = errors.Join(controlErr, nativeErr)
		if attempted && r.afterIO != nil {
			if n == 0 && nativeErr == nil && controlErr == nil {
				r.afterIO("eof")
			} else {
				r.afterIO("read")
			}
		}
		if code := r.guard(ctx, until); code != "" {
			return nil, ioFailure("request_"+code, false, controlErr, nativeErr, boundCauses(ctx, until))
		}
		if controlErr != nil || (nativeErr != nil && !retryable(nativeErr)) {
			return nil, ioFailure("request_read", false, controlErr, nativeErr)
		}
		if n > 0 {
			size += n
			if size > maxRequest {
				return nil, requestFailure("size", false)
			}
		} else if nativeErr == nil {
			if size == 0 {
				return nil, requestFailure("empty", false)
			}
			return append([]byte(nil), buffer[:size]...), nil
		}
		r.pause(ctx, until)
	}
}

// Close cancels and joins the actual active read before returning, then closes
// the retained owner exactly once. Copies share idempotent cleanup and cannot
// reuse the request. Nil and zero wrappers fail closed.
func (r *Request) Close() error {
	if r == nil || r.state == nil {
		return requestFailure("closed", false)
	}
	s := r.state
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		close(s.stop)
		s.mu.Unlock()
		s.active.Wait()
		if closeErr := s.input.close(); closeErr != nil {
			s.closeErr = s.terminal
			if s.closeErr == nil {
				s.closeErr = cleanupFailure("request_close", false, nil, closeErr)
			}
		} else {
			s.closeErr = retainedFailure(s.terminal)
		}
	})
	return s.closeErr
}

func requestGuardCode(code string) string {
	if code == "" {
		return ""
	}
	return "request_" + code
}

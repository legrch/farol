// Package helperchannels owns bounded one-shot ACK and continuation byte streams.
// It supplies transport only: trusted launch, role binding, peer trust, JSON,
// correlation and authorization remain the caller's responsibility.
package helperchannels

import (
	"context"
	"errors"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const maxFrame = 4096
const pollInterval = 2 * time.Millisecond

// Failure codes are stable transport outcomes. Uncertain means an ACK may have
// been exposed, its close could not be confirmed, or constructor cleanup failed.
// False never permits another attempt: even invalid/canceled calls consume
// their channel's one attempt.
// Continuation failures never return bytes or authorize an application effect.
type Failure struct {
	Code      string
	Uncertain bool
}

func (f *Failure) Error() string { return f.Code }

func failure(code string, uncertain bool) error {
	return &Failure{Code: "helper_channels_" + code, Uncertain: uncertain}
}

type owned struct {
	file *os.File
	raw  syscall.RawConn
	once sync.Once
	err  error
}

func (o *owned) close() error {
	if o == nil {
		return nil
	}
	o.once.Do(func() { o.err = o.file.Close() })
	return o.err
}

// Channels must not be copied. All operations, including invalid calls, are
// one-shot; Close cancels and joins active operations before returning.
type Channels struct {
	mu                sync.Mutex
	ack, continuation *owned
	ackUsed, contUsed bool
	ackUncertain      bool
	closed            bool
	stop              chan struct{}
	active            sync.WaitGroup
	closeOnce         sync.Once
	closeErr          error
	// Deterministic late-result tests only; nil in production.
	afterIO func(string)
}

// Take consumes exclusive ownership of all nonnil handles ON CALL, including
// failure. ACK is required. Pipes require O_WRONLY for ACK and O_RDONLY for
// continuation; stream sockets may be duplex. Owned O_NONBLOCK is enabled and
// owned socket SO_LINGER is disabled to bound native calls and close.
//
// The caller must transfer unique descriptions without borrowed aliases and
// never use them again. In particular request and borrowed lease roles must
// never be supplied here. No descriptor-number discovery/binding is performed.
// Same-pointer aliases are rejected; native metadata cannot prove absence of
// dup aliases (including separate os.File wrappers) or peer identity. FIFO
// inode values, including Darwin's zero inode, establish neither of those facts.
func Take(ack, continuation *os.File) (*Channels, error) {
	a := &owned{file: ack}
	var c *owned
	if continuation != nil {
		c = &owned{file: continuation}
	}
	fail := func(code string) (*Channels, error) {
		uncertain := false
		if ack != nil {
			prepareClose(ack)
			uncertain = a.close() != nil
		}
		if continuation != nil && continuation != ack {
			prepareClose(continuation)
			uncertain = c.close() != nil || uncertain
		}
		return nil, failure(code, uncertain)
	}
	if ack == nil {
		return fail("ack_required")
	}
	if ack == continuation {
		return fail("alias")
	}
	if err := configure(a, true); err != nil {
		return fail("ack_channel")
	}
	if c != nil {
		if err := configure(c, false); err != nil {
			return fail("continue_channel")
		}
	}
	return &Channels{ack: a, continuation: c, stop: make(chan struct{})}, nil
}

// Only a confirmed stream socket may have linger changed, including cleanup of
// a constructor rejected for another reason. Never apply options to other kinds.
func prepareClose(file *os.File) {
	raw, err := file.SyscallConn()
	if err != nil {
		return
	}
	_ = raw.Control(func(fd uintptr) {
		var st unix.Stat_t
		if unix.Fstat(int(fd), &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return
		}
		kind, err := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TYPE)
		if err == nil && kind == unix.SOCK_STREAM {
			_ = unix.SetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER, &unix.Linger{})
		}
	})
}

func configure(o *owned, write bool) error {
	raw, err := o.file.SyscallConn()
	if err != nil {
		return err
	}
	var nativeErr error
	err = raw.Control(func(fd uintptr) {
		var st unix.Stat_t
		if nativeErr = unix.Fstat(int(fd), &st); nativeErr != nil {
			return
		}
		switch st.Mode & unix.S_IFMT {
		case unix.S_IFIFO:
			var flags int
			flags, nativeErr = unix.FcntlInt(fd, unix.F_GETFL, 0)
			if nativeErr != nil {
				return
			}
			want := unix.O_RDONLY
			if write {
				want = unix.O_WRONLY
			}
			if flags&unix.O_ACCMODE != want {
				nativeErr = unix.EINVAL
				return
			}
		case unix.S_IFSOCK:
			var kind int
			kind, nativeErr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TYPE)
			if nativeErr != nil {
				return
			}
			if kind != unix.SOCK_STREAM {
				nativeErr = unix.EINVAL
				return
			}
			if nativeErr = unix.SetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER, &unix.Linger{}); nativeErr != nil {
				return
			}
		default:
			nativeErr = unix.EINVAL
			return
		}
		nativeErr = unix.SetNonblock(int(fd), true)
	})
	if err != nil {
		return err
	}
	if nativeErr == nil {
		o.raw = raw
	}
	return nativeErr
}

func (c *Channels) begin(ack bool) (*owned, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, failure("closed", ack && c.ackUncertain)
	}
	if ack {
		if c.ackUsed {
			// An active attempt may write immediately after this observation.
			return nil, failure("ack_used", c.ackUncertain)
		}
		c.ackUsed, c.ackUncertain = true, true
	} else {
		if c.contUsed {
			return nil, failure("continue_used", false)
		}
		c.contUsed = true
	}
	c.active.Add(1)
	if ack {
		return c.ack, nil
	}
	return c.continuation, nil
}

func (c *Channels) guard(ctx context.Context, until time.Time) string {
	if ctx == nil || until.IsZero() {
		return "bounds"
	}
	select {
	case <-c.stop:
		return "closed"
	default:
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "deadline"
	}
	if ctx.Err() != nil {
		return "cancelled"
	}
	if !time.Now().Before(until) {
		return "deadline"
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return "deadline"
	}
	return ""
}

func (c *Channels) pause(ctx context.Context, until time.Time) {
	delay := min(pollInterval, time.Until(until))
	if deadline, ok := ctx.Deadline(); ok {
		delay = min(delay, time.Until(deadline))
	}
	timer := time.NewTimer(max(delay, 0))
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-c.stop:
	case <-timer.C:
	}
}

// Emit attempts exactly one 1..4096-byte frame, then closes ACK to seal EOF.
// Any partial/late write remains uncertain. No failure permits another attempt.
func (c *Channels) Emit(ctx context.Context, until time.Time, frame []byte) (err error) {
	o, err := c.begin(true)
	if err != nil {
		return err
	}
	written := 0
	defer func() {
		if code := c.guard(ctx, until); code != "" && err == nil {
			err = failure(code, written > 0)
		}
		// Terminal cleanup is mandatory even after expiry/cancellation. Its EOF
		// may expose already-written bytes; it cannot convert a failure to success.
		if closeErr := o.close(); closeErr != nil {
			err = failure("ack_close", true)
		}
		if c.afterIO != nil {
			c.afterIO("ack_close")
		}
		if code := c.guard(ctx, until); code != "" && err == nil {
			err = failure(code, written > 0)
		}
		uncertain := written > 0
		if f, ok := err.(*Failure); ok {
			uncertain = uncertain || f.Uncertain
		}
		c.mu.Lock()
		c.ackUncertain = uncertain
		c.mu.Unlock()
		c.active.Done()
	}()
	if len(frame) < 1 || len(frame) > maxFrame {
		return failure("ack_size", false)
	}
	for written < len(frame) {
		if code := c.guard(ctx, until); code != "" {
			return failure(code, written > 0)
		}
		var n int
		var nativeErr error
		controlErr := o.raw.Control(func(fd uintptr) {
			// Recheck after acquiring the retained descriptor reference.
			if c.guard(ctx, until) == "" {
				n, nativeErr = unix.Write(int(fd), frame[written:])
			}
		})
		if n > 0 {
			written += n
		}
		if c.afterIO != nil {
			c.afterIO("write")
		}
		if code := c.guard(ctx, until); code != "" {
			return failure(code, written > 0)
		}
		if controlErr != nil || (nativeErr != nil && !retryable(nativeErr)) || (n == 0 && nativeErr == nil) {
			return failure("ack_write", written > 0)
		}
		if written < len(frame) {
			c.pause(ctx, until)
		}
	}
	return nil
}

func retryable(err error) bool {
	return errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EINTR)
}

// AwaitContinue returns only 1..4096 bytes sealed by EOF within the original
// bounds. Byte 4097, withheld EOF and late EOF fail without returning bytes.
func (c *Channels) AwaitContinue(ctx context.Context, until time.Time) (frame []byte, err error) {
	o, err := c.begin(false)
	if err != nil {
		return nil, err
	}
	defer func() {
		if code := c.guard(ctx, until); code != "" && err == nil {
			err = failure(code, false)
		}
		if o.close() != nil {
			err = failure("continue_close", false)
		}
		if code := c.guard(ctx, until); code != "" && err == nil {
			err = failure(code, false)
		}
		if err != nil {
			frame = nil
		}
		c.active.Done()
	}()
	if o == nil {
		return nil, failure("continue_missing", false)
	}
	var data [maxFrame + 1]byte
	size := 0
	for {
		if code := c.guard(ctx, until); code != "" {
			return nil, failure(code, false)
		}
		var n int
		var nativeErr error
		controlErr := o.raw.Control(func(fd uintptr) {
			if c.guard(ctx, until) == "" {
				n, nativeErr = unix.Read(int(fd), data[size:])
			}
		})
		if c.afterIO != nil {
			if n == 0 && nativeErr == nil && controlErr == nil {
				c.afterIO("eof")
			} else {
				c.afterIO("read")
			}
		}
		if code := c.guard(ctx, until); code != "" {
			return nil, failure(code, false)
		}
		if controlErr != nil || (nativeErr != nil && !retryable(nativeErr)) {
			return nil, failure("continue_read", false)
		}
		if n > 0 {
			size += n
			if size > maxFrame {
				return nil, failure("continue_size", false)
			}
		} else if nativeErr == nil {
			if size == 0 {
				return nil, failure("continue_size", false)
			}
			return append([]byte(nil), data[:size]...), nil
		}
		c.pause(ctx, until)
	}
}

// Close is idempotent, refuses reuse, and joins active nonblocking operations.
// It closes only the retained owners, exactly once, never detached fd numbers.
// A nil result confirms cleanup only; an interrupted Emit may have exposed ACK
// bytes and retains its own uncertain result. Close never grants replay.
func (c *Channels) Close() error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		close(c.stop)
		c.mu.Unlock()
		c.active.Wait()
		ackErr, contErr := c.ack.close(), c.continuation.close()
		if ackErr != nil {
			c.closeErr = failure("ack_close", true)
			c.mu.Lock()
			c.ackUncertain = true
			c.mu.Unlock()
		} else if contErr != nil {
			c.closeErr = failure("continue_close", false)
		}
	})
	return c.closeErr
}

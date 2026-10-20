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
// been exposed, its close could not be confirmed, constructor cleanup failed,
// or original uncertainty cannot be excluded within bounded cause inspection.
// False never permits another attempt: even invalid/canceled calls consume
// their channel's one attempt.
// Continuation failures never return bytes or authorize an application effect.
type Failure struct {
	Code      string
	Uncertain bool
	// CleanupUnconfirmed is independent of ACK exposure. A failed owned close
	// proves neither that the description remains open nor that it is closed.
	CleanupUnconfirmed bool
	cause              error
	nativeFailed       bool
}

func (f *Failure) Error() string { return f.Code }
func (f *Failure) Unwrap() error { return f.cause }

func failure(code string, uncertain bool, causes ...error) error {
	f := &Failure{Code: "helper_channels_" + code, Uncertain: uncertain, cause: errors.Join(causes...)}
	pending := append([]error(nil), causes...)
	for remaining := 128; len(pending) > 0; remaining-- {
		if remaining == 0 {
			f.Uncertain = true
			break
		}
		cause := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if cause == nil {
			continue
		}
		if prior, ok := cause.(*Failure); ok {
			f.Uncertain = f.Uncertain || prior.Uncertain
			f.CleanupUnconfirmed = f.CleanupUnconfirmed || prior.CleanupUnconfirmed
			f.nativeFailed = f.nativeFailed || prior.nativeFailed
		}
		switch e := cause.(type) {
		case interface{ Unwrap() []error }:
			children := e.Unwrap()
			if len(children) > remaining {
				f.Uncertain = true
				continue
			}
			pending = append(pending, children...)
		case interface{ Unwrap() error }:
			pending = append(pending, e.Unwrap())
		}
	}
	return f
}

func ioFailure(code string, uncertain bool, controlErr, nativeErr error, causes ...error) error {
	causes = append(causes, controlErr, nativeErr)
	f := failure(code, uncertain, causes...).(*Failure)
	f.nativeFailed = f.nativeFailed || controlErr != nil || nativeErr != nil && !retryable(nativeErr)
	return f
}

func cleanupFailure(code string, uncertain bool, prior, closeErr error) error {
	f := failure(code, uncertain, prior, closeErr).(*Failure)
	f.CleanupUnconfirmed = true
	return f
}

// Preserve both context notification and an elapsed absolute boundary, even if
// the context timer has not delivered yet. Causes never enter public Error().
func boundCauses(ctx context.Context, until time.Time) error {
	var causes []error
	if ctx != nil {
		causes = append(causes, ctx.Err(), context.Cause(ctx))
		if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
			causes = append(causes, context.DeadlineExceeded)
		}
	}
	if !until.IsZero() && !time.Now().Before(until) {
		causes = append(causes, context.DeadlineExceeded)
	}
	return errors.Join(causes...)
}

func retainBounds(prior error, code string, uncertain bool, ctx context.Context, until time.Time) error {
	if code == "" {
		return prior
	}
	if prior == nil {
		return failure(code, uncertain, boundCauses(ctx, until))
	}
	f := *prior.(*Failure)
	f.Uncertain = f.Uncertain || uncertain
	f.cause = errors.Join(prior, boundCauses(ctx, until))
	return &f
}

func mergeFailures(primary, other error) error {
	if primary == nil {
		return other
	}
	if other == nil {
		return primary
	}
	f := *primary.(*Failure)
	f.cause = errors.Join(primary, other)
	prior := other.(*Failure)
	f.Uncertain = f.Uncertain || prior.Uncertain
	f.CleanupUnconfirmed = f.CleanupUnconfirmed || prior.CleanupUnconfirmed
	f.nativeFailed = f.nativeFailed || prior.nativeFailed
	return &f
}

func retainedFailure(err error) error {
	f, ok := err.(*Failure)
	if !ok || !f.nativeFailed && !f.CleanupUnconfirmed {
		return nil
	}
	return err
}

type owned struct {
	file *os.File
	raw  syscall.RawConn
	once sync.Once
	err  error
	// Private deterministic fault seams; nil uses the original native calls.
	connect   func() (syscall.RawConn, error)
	read      func(int, []byte) (int, error)
	write     func(int, []byte) (int, error)
	closeFile func() error
}

func (o *owned) close() error {
	if o == nil {
		return nil
	}
	o.once.Do(func() {
		if o.closeFile != nil {
			o.err = o.closeFile()
		} else {
			o.err = o.file.Close()
		}
	})
	return o.err
}

func (o *owned) syscallConn() (syscall.RawConn, error) {
	if o.connect != nil {
		return o.connect()
	}
	return o.file.SyscallConn()
}
func (o *owned) readBytes(fd int, data []byte) (int, error) {
	if o.read != nil {
		return o.read(fd, data)
	}
	return unix.Read(fd, data)
}
func (o *owned) writeBytes(fd int, data []byte) (int, error) {
	if o.write != nil {
		return o.write(fd, data)
	}
	return unix.Write(fd, data)
}

// Channels wrappers share private ownership state even when copied. All
// operations, including invalid calls, are one-shot; Close cancels and joins
// active operations before returning. Nil and zero wrappers fail closed.
type Channels struct {
	state *channelState
}

type channelState struct {
	mu                sync.Mutex
	ack, continuation *owned
	ackUsed, contUsed bool
	ackUncertain      bool
	closed            bool
	stop              chan struct{}
	active            sync.WaitGroup
	closeOnce         sync.Once
	closeErr          error
	ackErr, contErr   error
	// Deterministic late-result tests only; nil in production.
	afterIO func(string)
}

// Take consumes exclusive ownership of all nonnil handles ON CALL, including
// failure. ACK is required. Pipes require O_WRONLY for ACK and O_RDONLY for
// continuation; stream sockets may be duplex. Owned O_NONBLOCK is enabled and
// owned socket SO_LINGER is disabled to bound native calls and close. FD_CLOEXEC
// is added to each owned descriptor so no exec'd child inherits it; failure to
// set it refuses before any I/O.
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
	fail := func(code string, causes ...error) (*Channels, error) {
		uncertain := false
		if ack != nil {
			causes = append(causes, prepareClose(ack))
			closeErr := a.close()
			causes = append(causes, closeErr)
			uncertain = closeErr != nil
		}
		if continuation != nil && continuation != ack {
			causes = append(causes, prepareClose(continuation))
			closeErr := c.close()
			causes = append(causes, closeErr)
			uncertain = closeErr != nil || uncertain
		}
		f := failure(code, uncertain, causes...).(*Failure)
		f.CleanupUnconfirmed = uncertain
		return nil, f
	}
	if ack == nil {
		return fail("ack_required")
	}
	if ack == continuation {
		return fail("alias")
	}
	if err := configure(a, true); err != nil {
		return fail("ack_channel", err)
	}
	if c != nil {
		if err := configure(c, false); err != nil {
			return fail("continue_channel", err)
		}
	}
	return &Channels{state: &channelState{ack: a, continuation: c, stop: make(chan struct{})}}, nil
}

// Only a confirmed stream socket may have linger changed, including cleanup of
// a constructor rejected for another reason. Never apply options to other kinds.
func prepareClose(file *os.File) error {
	raw, err := file.SyscallConn()
	if err != nil {
		return err
	}
	var nativeErr error
	err = raw.Control(func(fd uintptr) {
		var st unix.Stat_t
		if nativeErr = unix.Fstat(int(fd), &st); nativeErr != nil || st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return
		}
		var kind int
		kind, nativeErr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TYPE)
		if nativeErr == nil && kind == unix.SOCK_STREAM {
			nativeErr = unix.SetsockoptLinger(int(fd), unix.SOL_SOCKET, unix.SO_LINGER, &unix.Linger{})
		}
	})
	return errors.Join(err, nativeErr)
}

// closeOnExec only adds FD_CLOEXEC to this process's descriptor flags: it reads
// F_GETFD and writes it back with that one bit ORed in. The flag is per process
// and per descriptor number, so the parent's table and the shared open-file
// description are untouched. It stops a later exec.Command child (for example
// /bin/ps) from inheriting this transport.
func closeOnExec(fd uintptr) error {
	flags, err := unix.FcntlInt(fd, unix.F_GETFD, 0)
	if err != nil {
		return err
	}
	if flags&unix.FD_CLOEXEC != 0 {
		return nil
	}
	_, err = unix.FcntlInt(fd, unix.F_SETFD, flags|unix.FD_CLOEXEC)
	return err
}

func configure(o *owned, write bool) error {
	raw, err := o.syscallConn()
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
		if nativeErr = unix.SetNonblock(int(fd), true); nativeErr != nil {
			return
		}
		nativeErr = closeOnExec(fd)
	})
	if err == nil && nativeErr == nil {
		o.raw = raw
	}
	return errors.Join(err, nativeErr)
}

func (c *channelState) begin(ack bool) (*owned, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		if ack {
			return nil, failure("closed", c.ackUncertain, c.ackErr)
		}
		return nil, failure("closed", false, c.contErr)
	}
	if ack {
		if c.ackUsed {
			// An active attempt may write immediately after this observation.
			return nil, failure("ack_used", c.ackUncertain, c.ackErr)
		}
		c.ackUsed, c.ackUncertain = true, true
	} else {
		if c.contUsed {
			return nil, failure("continue_used", false, c.contErr)
		}
		c.contUsed = true
	}
	c.active.Add(1)
	if ack {
		return c.ack, nil
	}
	return c.continuation, nil
}

func (c *channelState) guard(ctx context.Context, until time.Time) string {
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

func (c *channelState) pause(ctx context.Context, until time.Time) {
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
// The caller must not mutate frame concurrently with initial snapshot capture.
// Subsequent waiting and native writes use only that bounded private snapshot.
func (c *Channels) Emit(ctx context.Context, until time.Time, frame []byte) error {
	if c == nil || c.state == nil {
		return failure("closed", false)
	}
	if len(frame) >= 1 && len(frame) <= maxFrame {
		frame = append([]byte(nil), frame...)
	}
	return c.state.emit(ctx, until, frame)
}

func (c *channelState) emit(ctx context.Context, until time.Time, frame []byte) (err error) {
	o, err := c.begin(true)
	if err != nil {
		return err
	}
	written := 0
	defer c.active.Done()
	defer func() {
		err = retainBounds(err, c.guard(ctx, until), written > 0, ctx, until)
		// Terminal cleanup is mandatory even after expiry/cancellation. Its EOF
		// may expose already-written bytes; it cannot convert a failure to success.
		if closeErr := o.close(); closeErr != nil {
			err = cleanupFailure("ack_close", true, err, closeErr)
		}
		if c.afterIO != nil {
			c.afterIO("ack_close")
		}
		err = retainBounds(err, c.guard(ctx, until), written > 0, ctx, until)
		uncertain := written > 0
		if f, ok := err.(*Failure); ok {
			uncertain = uncertain || f.Uncertain
		}
		c.mu.Lock()
		c.ackUncertain = uncertain
		c.ackErr = err
		c.mu.Unlock()
	}()
	if len(frame) < 1 || len(frame) > maxFrame {
		return failure("ack_size", false)
	}
	var lastErr error
	for written < len(frame) {
		if code := c.guard(ctx, until); code != "" {
			return failure(code, written > 0, lastErr, boundCauses(ctx, until))
		}
		var n int
		var nativeErr error
		controlErr := o.raw.Control(func(fd uintptr) {
			// Recheck after acquiring the retained descriptor reference.
			if c.guard(ctx, until) == "" {
				n, nativeErr = o.writeBytes(int(fd), frame[written:])
			}
		})
		lastErr = errors.Join(controlErr, nativeErr)
		if n > 0 {
			written += n
		}
		if c.afterIO != nil {
			c.afterIO("write")
		}
		if code := c.guard(ctx, until); code != "" {
			return ioFailure(code, written > 0, controlErr, nativeErr, boundCauses(ctx, until))
		}
		if controlErr != nil || (nativeErr != nil && !retryable(nativeErr)) || (n == 0 && nativeErr == nil) {
			return ioFailure("ack_write", written > 0, controlErr, nativeErr)
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
func (c *Channels) AwaitContinue(ctx context.Context, until time.Time) ([]byte, error) {
	if c == nil || c.state == nil {
		return nil, failure("closed", false)
	}
	return c.state.awaitContinue(ctx, until)
}

func (c *channelState) awaitContinue(ctx context.Context, until time.Time) (frame []byte, err error) {
	o, err := c.begin(false)
	if err != nil {
		return nil, err
	}
	defer c.active.Done()
	defer func() {
		err = retainBounds(err, c.guard(ctx, until), false, ctx, until)
		if closeErr := o.close(); closeErr != nil {
			err = cleanupFailure("continue_close", false, err, closeErr)
		}
		err = retainBounds(err, c.guard(ctx, until), false, ctx, until)
		if err != nil {
			frame = nil
		}
		c.mu.Lock()
		c.contErr = err
		c.mu.Unlock()
	}()
	if o == nil {
		return nil, failure("continue_missing", false)
	}
	var data [maxFrame + 1]byte
	size := 0
	var lastErr error
	for {
		if code := c.guard(ctx, until); code != "" {
			return nil, failure(code, false, lastErr, boundCauses(ctx, until))
		}
		var n int
		var nativeErr error
		controlErr := o.raw.Control(func(fd uintptr) {
			if c.guard(ctx, until) == "" {
				n, nativeErr = o.readBytes(int(fd), data[size:])
			}
		})
		lastErr = errors.Join(controlErr, nativeErr)
		if c.afterIO != nil {
			if n == 0 && nativeErr == nil && controlErr == nil {
				c.afterIO("eof")
			} else {
				c.afterIO("read")
			}
		}
		if code := c.guard(ctx, until); code != "" {
			return nil, ioFailure(code, false, controlErr, nativeErr, boundCauses(ctx, until))
		}
		if controlErr != nil || (nativeErr != nil && !retryable(nativeErr)) {
			return nil, ioFailure("continue_read", false, controlErr, nativeErr)
		}
		if n > 0 {
			size += n
			if size > maxFrame {
				return nil, failure("continue_size", false)
			}
		} else if nativeErr == nil {
			if size == 0 {
				// Preserve an empty sealed frame separately from overflow so
				// the helper owner can retain its continue_invalid classification.
				return nil, failure("continue_empty", false)
			}
			return append([]byte(nil), data[:size]...), nil
		}
		c.pause(ctx, until)
	}
}

// Close is idempotent, refuses reuse, and joins active nonblocking operations.
// It closes only the retained owners, exactly once, never detached fd numbers.
// Native/cleanup failures retain their terminal causes on Close. A call stopped
// by Close itself keeps its own closed result; successful cleanup may return nil.
// Neither result grants replay or application authority.
func (c *Channels) Close() error {
	if c == nil || c.state == nil {
		return failure("closed", false)
	}
	return c.state.close()
}

func (c *channelState) close() error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		close(c.stop)
		c.mu.Unlock()
		c.active.Wait()
		ackErr, contErr := c.ack.close(), c.continuation.close()
		ackTerminal, contTerminal := retainedFailure(c.ackErr), retainedFailure(c.contErr)
		if ackErr != nil {
			if ackTerminal == nil {
				ackTerminal = cleanupFailure("ack_close", true, c.ackErr, ackErr)
			}
			c.mu.Lock()
			c.ackUncertain = true
			c.mu.Unlock()
		}
		if contErr != nil && contTerminal == nil {
			contTerminal = cleanupFailure("continue_close", false, c.contErr, contErr)
		}
		// Retain the historical close-code precedence, while keeping both
		// channels' original failures, including a peer with successful cleanup.
		if contErr != nil && ackErr == nil {
			c.closeErr = mergeFailures(contTerminal, ackTerminal)
		} else {
			c.closeErr = mergeFailures(ackTerminal, contTerminal)
		}
	})
	return c.closeErr
}

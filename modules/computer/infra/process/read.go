package process

import (
	"context"
	"sync"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type Child struct {
	mutex                                                                                 sync.Mutex
	handle                                                                                string
	process                                                                               owned
	root                                                                                  processsvc.RootState
	group, descendants                                                                    processsvc.Cleanup
	waited, drained, finished                                                             bool
	code                                                                                  *int
	signal                                                                                int
	stdout, stderr                                                                        []byte
	outputLimit, cancelRequested, timedOut, authorityLost, signalAttempted, signalUnknown bool
	deadline, watch                                                                       timer
	done                                                                                  chan struct{}
}

var _ processsvc.Child = (*Child)(nil)

func (c *Child) Handle() string { return c.handle }
func (c *Child) wait() {
	observed, err := c.process.Wait()
	c.mutex.Lock()
	if err == nil && observed.Waited {
		c.root = processsvc.RootExited
		c.waited = true
		c.drained = observed.Drained
		c.signal = observed.Signal
		if observed.Code != nil {
			code := *observed.Code
			c.code = &code
		}
	}
	// os.Process.Wait is EXACT root evidence only. Unsupported descendant tracking
	// and anchor-less group cleanup remain unverified even for a clean exit 0.
	c.finished = true
	c.group = processsvc.CleanupUnverified
	c.descendants = processsvc.CleanupUnverified
	deadline, watch := c.deadline, c.watch
	close(c.done)
	c.mutex.Unlock()
	if deadline != nil {
		deadline.Stop()
	}
	if watch != nil {
		watch.Stop()
	}
}
func window(data []byte, offset uint64) ([]byte, bool) {
	if offset > uint64(len(data)) {
		return nil, false
	}
	end := offset + processsvc.WindowBytes
	if end > uint64(len(data)) {
		end = uint64(len(data))
	}
	return append([]byte(nil), data[int(offset):int(end)]...), true
}
func (c *Child) Read(ctx context.Context, request processsvc.Window) (*processsvc.Observation, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	out, ok := window(c.stdout, request.StdoutOffset)
	if !ok {
		return nil, &processsvc.NativeFailure{}
	}
	diagnostic, ok := window(c.stderr, request.StderrOffset)
	if !ok {
		return nil, &processsvc.NativeFailure{}
	}
	var code *int
	if c.code != nil {
		copy := *c.code
		code = &copy
	}
	return &processsvc.Observation{Handle: c.handle, Root: c.root, Waited: c.waited, ExitCode: code, ExitSignal: c.signal,
		GroupCleanup: c.group, DescendantCleanup: c.descendants, Stdout: out, Stderr: diagnostic,
		StdoutOffset: request.StdoutOffset, StderrOffset: request.StderrOffset,
		StdoutNext: request.StdoutOffset + uint64(len(out)), StderrNext: request.StderrOffset + uint64(len(diagnostic)),
		StdoutBytes: uint64(len(c.stdout)), StderrBytes: uint64(len(c.stderr)),
		OutputLimitReached: c.outputLimit, OutputDrained: c.drained, CancelRequested: c.cancelRequested, TimedOut: c.timedOut, AuthorityLost: c.authorityLost}, nil
}

type output struct {
	child  *Child
	stderr bool
}

func (w output) Write(data []byte) (int, error) {
	c := w.child
	c.mutex.Lock()
	available := processsvc.MaximumOutput - len(c.stdout) - len(c.stderr)
	count := len(data)
	if count > available {
		count = available
		c.outputLimit = true
	}
	if w.stderr {
		c.stderr = append(c.stderr, data[:count]...)
	} else {
		c.stdout = append(c.stdout, data[:count]...)
	}
	limited, ready := c.outputLimit, c.process != nil
	c.mutex.Unlock()
	if limited && ready {
		c.stop(false)
	}
	// Always drain; truncation/cancellation is explicit, not an IO retry.
	return len(data), nil
}

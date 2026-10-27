package process

import (
	"context"
	"sync"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type Child struct {
	supervisor                                                                            processsvc.SupervisorState
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
	signalCompleted, signalTerminal                                                       bool
	signalDone                                                                            chan struct{}
	deadline, watch                                                                       timer
	done                                                                                  chan struct{}
}

var _ processsvc.Child = (*Child)(nil)
var _ processsvc.ChildCompletion = (*Child)(nil)

func (c *Child) Handle() string { return c.handle }

// WaitForCompletion observes only the existing waiter's notification. Root
// Wait, stop settlement, output drain and cohort cleanup must still be validated
// by retention.
func (c *Child) WaitForCompletion(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return &processsvc.NativeFailure{}
	}
	if c == nil || c.done == nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		if err := ctx.Err(); err != nil {
			return err
		}
		return nil
	}
}

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
	// Preserve the original root facts immediately, but do not publish completion
	// or classify the supervisor until the single original control call resolves.
	// Waiting outside the mutex lets Kill, IPC fences and cancellation contexts
	// publish their independent sticky result.
	if c.signalAttempted && !c.signalCompleted && c.signalDone != nil {
		settled := c.signalDone
		c.mutex.Unlock()
		<-settled
		c.mutex.Lock()
	}
	// os.Process.Wait is EXACT root evidence only. Unsupported descendant tracking
	// remain unverified even for a clean exit 0; group cleanup needs its own witness.
	if c.supervisor != "" {
		previous := c.supervisor
		c.supervisor = processsvc.SupervisorUnknown
		stopKnown := !c.signalUnknown && (!c.signalAttempted || c.signalCompleted)
		if previous == processsvc.SupervisorRunning && err == nil && observed.supervisorExited && observed.Waited && observed.Drained && stopKnown {
			c.supervisor = processsvc.SupervisorExited
		}
	}
	c.finished = true
	c.group = processsvc.CleanupUnverified
	c.descendants = processsvc.CleanupUnverified
	if c.supervisor == processsvc.SupervisorExited && observed.groupGone && !c.signalUnknown {
		c.group = processsvc.CleanupConfirmed
	}
	if err == nil && observed.Waited && observed.Drained && observed.cohort && (!c.signalAttempted || c.signalTerminal) && !c.signalUnknown {
		c.group, c.descendants = processsvc.CleanupConfirmed, processsvc.CleanupConfirmed
	}
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
	return &processsvc.Observation{Supervisor: c.supervisor, Handle: c.handle, Root: c.root, Waited: c.waited, ExitCode: code, ExitSignal: c.signal,
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

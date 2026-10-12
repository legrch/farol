package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func (c *Child) stop(timeout bool) {
	if settled := c.requestStop(timeout); settled != nil {
		<-settled // Automatic stops share the original result, outside the mutex.
	}
}

// requestStop retains the single original Kill independently of root Wait and
// any cancellation caller's context. A pending request is not an acknowledgement.
func (c *Child) requestStop(timeout bool) <-chan struct{} {
	c.mutex.Lock()
	if c.signalAttempted {
		settled := c.signalDone
		c.mutex.Unlock()
		return settled
	}
	if c.finished {
		c.mutex.Unlock()
		return nil
	}
	c.signalAttempted = true
	c.signalDone = make(chan struct{})
	settled := c.signalDone
	c.cancelRequested = true
	c.timedOut = timeout
	root := c.process
	c.mutex.Unlock()
	// Only the retained owning resource: direct process handle or scoped anchor
	// control link. No integer identity, group scan,
	// escalation, alternate signal or executor after a refusal/unknown result.
	go func() {
		err := root.Kill()
		c.mutex.Lock()
		if err != nil {
			c.markStopUnknown()
		}
		c.signalCompleted = true
		close(settled)
		c.mutex.Unlock()
	}()
	return settled
}

// markStopUnknown requires the mutex. No later successful Kill or Wait can clear
// a failed control result or a cancellation caller's lost acknowledgement.
func (c *Child) markStopUnknown() {
	c.signalUnknown = true
	c.group, c.descendants = processsvc.CleanupUnverified, processsvc.CleanupUnverified
	if c.supervisor != "" {
		c.supervisor = processsvc.SupervisorUnknown
	}
}
func (c *Child) Cancel(ctx context.Context) (*processsvc.CancelReceipt, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	if settled := c.requestStop(false); settled != nil {
		select {
		case <-settled:
		case <-ctx.Done():
		}
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if ctx.Err() != nil {
		c.markStopUnknown()
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	status := processsvc.CancelRequested
	if !c.signalAttempted || !c.signalCompleted || c.signalUnknown {
		status = processsvc.CancelUnknown
	}
	return &processsvc.CancelReceipt{Handle: c.handle, Status: status}, nil
}

package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func (c *Child) stop(timeout bool) {
	c.mutex.Lock()
	if c.signalAttempted || c.finished {
		c.mutex.Unlock()
		return
	}
	c.signalAttempted = true
	c.cancelRequested = true
	c.timedOut = timeout
	root := c.process
	c.mutex.Unlock()
	// Only the retained os.Process handle. No integer identity, group scan,
	// escalation, alternate signal or executor after a refusal/unknown result.
	err := root.Kill()
	c.mutex.Lock()
	if err != nil {
		c.signalUnknown = true
		c.group = processsvc.CleanupUnverified
		c.descendants = processsvc.CleanupUnverified
	}
	c.mutex.Unlock()
}
func (c *Child) Cancel(ctx context.Context) (*processsvc.CancelReceipt, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	c.stop(false)
	c.mutex.Lock()
	defer c.mutex.Unlock()
	status := processsvc.CancelRequested
	if c.signalUnknown || c.finished {
		status = processsvc.CancelUnknown
	}
	return &processsvc.CancelReceipt{Handle: c.handle, Status: status}, nil
}

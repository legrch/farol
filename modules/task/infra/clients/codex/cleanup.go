package codex

import (
	"context"
	"sync"
	"time"

	task "github.com/legrch/farol/modules/task/domain"
)

type clientProcess struct {
	Process
	once sync.Once
	err  error
}

func (p *clientProcess) Close() error {
	p.once.Do(func() { p.err = p.Process.Close() })
	return p.err
}

// scheduleCleanup starts only after the original Launch has registered its
// result. It never waits on the read gate or holds the mutex during process IO.
// The first Close's budget is fixed; late registration cannot renew it.
func (c *Client) scheduleCleanup() {
	c.mu.Lock()
	if !c.closeStarted || c.launching || c.cleanupStarted {
		c.mu.Unlock()
		return
	}
	c.cleanupStarted = true
	conn, launchErr, ctx, cancel := c.connection, c.launchErr, c.closeCtx, c.closeCancel
	if conn == nil {
		if launchErr != nil {
			c.closeErr = task.ErrUnknown
		}
		close(c.closeDone)
		c.mu.Unlock()
		cancel()
		return
	}
	c.mu.Unlock()
	go func() {
		defer cancel()
		conn.fail()
		// This reads the wrapper's retained result, never another termination.
		terminationErr := conn.process.Close()
		exitErr := conn.process.Wait(ctx)
		c.mu.Lock()
		deadline, bounded := ctx.Deadline()
		// Timer cancellation delivery may lag the deadline. A late proof is
		// still late even when the original context has not notified us yet.
		if launchErr != nil || terminationErr != nil || exitErr != nil || ctx.Err() != nil || bounded && !time.Now().Before(deadline) {
			c.closeErr = task.ErrUnknown
		}
		// A caller's earlier unproved timeout/cancellation remains unknown even
		// if the original child supplies exit proof after that caller returned.
		close(c.closeDone)
		c.mu.Unlock()
	}()
}

// Close fences both an in-flight Launch and the retained original proxy. It
// never interrupts a provider turn or repeats termination/exit collection. Its
// bounded wait runs outside the read gate, including from authority callbacks.
func (c *Client) Close(ctx context.Context) error {
	if ctx == nil {
		return task.ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	c.mu.Lock()
	if !c.closeStarted {
		c.closed.Store(true)
		c.closeStarted = true
		// Cleanup stays owned when a caller is cancelled, including by closing
		// this same Client lifetime from its own authority callback. Detach its
		// cancellation, but retain the first owner's already capped deadline.
		deadline, _ := ctx.Deadline()
		c.closeCtx, c.closeCancel = context.WithDeadline(context.Background(), deadline)
		// Retain an expired first owner's uncertainty before fast cleanup can
		// publish a late exit proof. An inert client has no original to join.
		if c.attempted && ctx.Err() != nil {
			c.closeErr = task.ErrUnknown
		}
	}
	c.mu.Unlock()
	c.cancel()
	c.scheduleCleanup()
	// Completed cleanup wins over a later caller cancellation.
	select {
	case <-c.closeDone:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.closeErr
	default:
	}
	c.mu.Lock()
	retained := c.closeErr
	c.mu.Unlock()
	if retained != nil {
		return retained
	}
	select {
	case <-c.closeDone:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.closeErr
	case <-ctx.Done():
		c.mu.Lock()
		defer c.mu.Unlock()
		select {
		case <-c.closeDone:
			return c.closeErr
		default:
			c.closeErr = task.ErrUnknown
			return c.closeErr
		}
	}
}

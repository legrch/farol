package boot

import (
	"context"
	"sync"
)

// selfTestParentGate owns one original diagnostic lifetime from before parent
// admission through terminal Save. Unknown admission or outcome fences future
// diagnostic starts in this lifetime. It does not grant workspace authority.
type selfTestParentGate struct {
	mu                      sync.Mutex
	active, blocked, closed bool
	done                    chan struct{}
	cancel                  context.CancelFunc
}

func (g *selfTestParentGate) begin(cancel context.CancelFunc) bool {
	if g == nil || cancel == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active || g.blocked || g.closed {
		return false
	}
	g.active, g.cancel, g.done = true, cancel, make(chan struct{})
	return true
}

func (g *selfTestParentGate) finish(uncertain bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.active {
		return
	}
	if uncertain {
		g.blocked = true
	}
	g.active, g.cancel = false, nil
	close(g.done)
}

// stop closes admission and signals only the original attempt. It never
// retries it. wait is separate so no owner lock is held during a join.
func (g *selfTestParentGate) stop() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.closed = true
	cancel := g.cancel
	g.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// freeze prevents a new parent before retirement inspects the ledger. A live
// or unconfirmed original cannot be reported as a clean retirement.
func (g *selfTestParentGate) freeze() bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	return g.active || g.blocked
}
func (g *selfTestParentGate) wait() {
	if g == nil {
		return
	}
	g.mu.Lock()
	done := g.done
	active := g.active
	g.mu.Unlock()
	if active && done != nil {
		<-done
	}
}

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
	operation               string
}

func (g *selfTestParentGate) begin(operation string, cancel context.CancelFunc) bool {
	if g == nil || cancel == nil || operation == "" {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active || g.blocked || g.closed {
		return false
	}
	g.active, g.cancel, g.done, g.operation = true, cancel, make(chan struct{}), operation
	return true
}

func (g *selfTestParentGate) originalOperation() string {
	if g == nil {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.operation
}

// Caller holds ledger.mu when coordinating with recovery reservation.
func (g *selfTestParentGate) disposition() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.blocked {
		return "operation_unknown"
	}
	if g.active {
		return "pending_operation"
	}
	return "settled"
}

func (s *SettingsMutationIngress) beginSelfTestParent(operation string, cancel context.CancelFunc) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen || s.stageClosed || s.processDraining || s.recoveryReserved || s.retirementErr != nil {
		return false
	}
	return s.selfTestParent.begin(operation, cancel)
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

// The parent may return UNKNOWN after cancellation while its original Shell
// collector is still finishing. Join only the two fixed children of that
// original parent before closing the journal; never start or cancel again.
func (s *SettingsMutationIngress) waitSelfTestCollectors() {
	if s == nil {
		return
	}
	old, oldOK := selfTestIDsV1(s.selfTestParent.originalOperation())
	current, currentOK := selfTestIDsV2(s.selfTestParent.originalOperation())
	if !oldOK || !currentOK {
		return
	}
	s.mu.Lock()
	var pending []<-chan struct{}
	for _, operation := range []string{old.quick, old.cancel, current.quick, current.cancel} {
		if record := s.operations[operation]; record != nil && record.process != nil && record.process.collectionDone != nil {
			pending = append(pending, record.process.collectionDone)
		}
	}
	s.mu.Unlock()
	for _, done := range pending {
		<-done
	}
}

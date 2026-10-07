package lifecycle

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

// ClosedLease retains existing read-only claims, not a writer or origin proof.
// Verify qualifies the original canonical pathname; after a deliberate checked
// preservation rename it must refuse. Close still releases only its own fds and
// never reports retirement or removes a fence. Boot owns any separate effect.
type ClosedLease struct {
	mu                sync.Mutex
	value             ClosedInspection
	verify            func() error
	close             func() error
	closed            bool
	failure, closeErr error
}

func AcquireClosedInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits) (*ClosedLease, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	if !validID(root.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != root.ProfileID || !validLimits(limits) || limits.Bytes > 1024*1024 || limits.Records > 4096 {
		return nil, failure(Invalid, false)
	}
	return acquireClosedInspection(ctx, root, scope, limits)
}
func (l *ClosedLease) Observation() (ClosedInspection, error) {
	if l == nil {
		return ClosedInspection{}, failure(Unavailable, false)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.failure != nil {
		return ClosedInspection{}, failure(Unavailable, false)
	}
	v := l.value
	v.Incarnations = append([]string(nil), v.Incarnations...)
	return v, nil
}
func (l *ClosedLease) Verify() error {
	if l == nil {
		return failure(Unavailable, false)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return failure(Unavailable, false)
	}
	if l.failure != nil {
		return l.failure
	}
	l.failure = l.verify()
	return l.failure
}
func (l *ClosedLease) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		l.closeErr = l.close()
	}
	return l.closeErr
}

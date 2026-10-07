package results

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

// ClosedLease retains read-only result claims without opening a result owner.
// Original-path Verify must refuse after relocation. Close releases only these
// descriptors, without publication, poison or a cleanup/retirement claim.
type ClosedLease struct {
	mu                sync.Mutex
	value             ClosedInspection
	verify            func() error
	close             func() error
	closed            bool
	failure, closeErr error
}

func AcquireClosedInspection(ctx context.Context, root Root, scope port.JournalScope) (*ClosedLease, error) {
	if nilContext(ctx) || ctx.Err() != nil || !validID(root.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != root.ProfileID || root.Identity.Device == 0 || root.Identity.Inode == 0 {
		return nil, Invalid
	}
	return acquireClosedInspection(ctx, root, scope)
}
func (l *ClosedLease) Observation() (ClosedInspection, error) {
	if l == nil {
		return ClosedInspection{}, Unavailable
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.failure != nil {
		return ClosedInspection{}, Unavailable
	}
	return l.value, nil
}
func (l *ClosedLease) Verify() error {
	if l == nil {
		return Unavailable
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return Unavailable
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

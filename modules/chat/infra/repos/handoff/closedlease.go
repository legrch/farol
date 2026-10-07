package handoff

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

// ClosedLease retains the existing read-only handoff claim. Its observation is
// still persisted data, not a live origin or recovery proof. Verify qualifies
// only the original canonical path; Close releases owned descriptors even
// after independently checked preservation, without rewriting old fences.
type ClosedLease struct {
	mu                sync.Mutex
	value             ClosedInspection
	verify            func() error
	close             func() error
	closed            bool
	failure, closeErr error
}

func AcquireClosedInspection(ctx context.Context, roots Roots, scope port.JournalScope) (*ClosedLease, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	if !historyID(roots.ProfileID) || !historyID(scope.BackendGeneration) || scope.ProfileID != roots.ProfileID {
		return nil, fail(Invalid, false)
	}
	return acquireClosedInspection(ctx, roots, scope)
}
func (l *ClosedLease) Observation() (ClosedInspection, error) {
	if l == nil {
		return ClosedInspection{}, fail(Unavailable, false)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.failure != nil {
		return ClosedInspection{}, fail(Unavailable, false)
	}
	v := l.value
	v.Stages = append([]ClosedInspectionStage(nil), v.Stages...)
	v.Head = copyClosedInspectionHead(v.Head)
	return v, nil
}
func (l *ClosedLease) Verify() error {
	if l == nil {
		return fail(Unavailable, false)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return fail(Unavailable, false)
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

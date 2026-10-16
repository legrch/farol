package lifecycle

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
)

// PreservationLease retains the existing read-only claim over one complete
// canonical lifecycle snapshot, including nonempty or unknown history. It
// neither retires that scope nor authorizes a successor, replay or relocation.
// Whole-profile inventory, original process/Computer settlement, preservation
// and fresh-owner admission remain the enclosing application's responsibilities.
type PreservationLease struct {
	// Reuse only the existing serialization, poisoned lifetime and owned Close.
	// The empty ClosedInspection projection is never populated or exposed.
	lifetime *ClosedLease
	value    Inspection
	ctx      context.Context
}

// AcquirePreservationInspection opens no writer and changes no journal, claim,
// fence or directory. The original caller deadline is captured once before any
// lock or filesystem observation. No fresh context can extend this lease.
func AcquirePreservationInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits) (*PreservationLease, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	until, bounded := ctx.Deadline()
	if !bounded || until.IsZero() || !validID(root.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != root.ProfileID || !validLimits(limits) || limits.Bytes > 1024*1024 || limits.Records > 4096 {
		return nil, failure(Invalid, false)
	}
	bound := preservationContext{Context: ctx, until: until}
	if bound.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	return acquirePreservationInspection(bound, root, scope, limits)
}

// Observation returns an independent provisional metadata copy under the same
// retained claim. Verify must qualify the original canonical path before and
// after any composite observation; Close releases only our descriptors.
func (l *PreservationLease) Observation() (*Inspection, error) {
	if l == nil || l.lifetime == nil || l.ctx == nil {
		return nil, failure(Unavailable, false)
	}
	l.lifetime.mu.Lock()
	defer l.lifetime.mu.Unlock()
	if l.lifetime.closed || l.lifetime.failure != nil {
		return nil, failure(Unavailable, false)
	}
	if l.ctx.Err() != nil {
		l.lifetime.failure = failure(Cancelled, false)
		return nil, l.lifetime.failure
	}
	v := copyPreservationInspection(l.value)
	return &v, nil
}

func (l *PreservationLease) Verify() error {
	if l == nil || l.lifetime == nil {
		return failure(Unavailable, false)
	}
	return l.lifetime.Verify()
}

func (l *PreservationLease) Close() error {
	if l == nil || l.lifetime == nil {
		return nil
	}
	return l.lifetime.Close()
}

func copyPreservationInspection(v Inspection) Inspection {
	v.Incarnations = append([]string(nil), v.Incarnations...)
	if v.Retirement != nil {
		retirement := *v.Retirement
		v.Retirement = &retirement
	}
	return v
}

type preservationContext struct {
	context.Context
	until time.Time
}

func (c preservationContext) Deadline() (time.Time, bool) { return c.until, true }
func (c preservationContext) Err() error {
	if err := c.Context.Err(); err != nil {
		return err
	}
	if !time.Now().Before(c.until) {
		return context.DeadlineExceeded
	}
	return nil
}

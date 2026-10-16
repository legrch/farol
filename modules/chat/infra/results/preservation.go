package results

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
)

// PreservationInspection is provisional metadata for one complete bounded
// canonical result namespace. Unresolved includes a retained UNKNOWN marker or
// an uncommitted canonical attempt. Neither a commit nor this inspection proves
// publication success, ACK, lifecycle origin or current read/write authority.
type PreservationInspection struct {
	Scope                       port.JournalScope
	Root, StorageRoot           port.JournalRoot
	ClaimDigest, SnapshotDigest [32]byte
	ResultCount, PayloadBytes   int
	Unresolved                  bool
}

// PreservationLease holds the existing read-only claim and an immutable
// inventory, without constructing, fencing or repairing a mutable result owner.
// The original bounded context governs every observation and final Verify.
type PreservationLease struct {
	lifetime *ClosedLease
	value    PreservationInspection
	ctx      context.Context
}

func AcquirePreservationInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits) (*PreservationLease, error) {
	if nilContext(ctx) || ctx.Err() != nil {
		return nil, Invalid
	}
	until, bounded := ctx.Deadline()
	if !bounded || until.IsZero() || !validResultComposition(ctx, ctx, root, scope, limits, "open") {
		return nil, Invalid
	}
	bound := preservationContext{Context: ctx, until: until}
	if bound.Err() != nil {
		return nil, Unavailable
	}
	return acquirePreservationInspection(bound, root, scope, limits)
}

// Observation returns metadata only. The enclosing owner must Verify before
// and after its composite observation; no fresh context may renew the claim.
func (l *PreservationLease) Observation() (PreservationInspection, error) {
	if l == nil || l.lifetime == nil || l.ctx == nil {
		return PreservationInspection{}, Unavailable
	}
	l.lifetime.mu.Lock()
	defer l.lifetime.mu.Unlock()
	if l.lifetime.closed || l.lifetime.failure != nil {
		return PreservationInspection{}, Unavailable
	}
	if l.ctx.Err() != nil {
		l.lifetime.failure = Unavailable
		return PreservationInspection{}, Unavailable
	}
	return l.value, nil
}

func (l *PreservationLease) Verify() error {
	if l == nil || l.lifetime == nil || l.ctx == nil {
		return Unavailable
	}
	// Serialize the original deadline with the final filesystem recheck and
	// sticky failure; a successful late read cannot revive this lease.
	l.lifetime.mu.Lock()
	defer l.lifetime.mu.Unlock()
	if l.lifetime.closed {
		return Unavailable
	}
	if l.lifetime.failure != nil {
		return l.lifetime.failure
	}
	if l.ctx.Err() != nil {
		l.lifetime.failure = Unavailable
	} else {
		l.lifetime.failure = l.lifetime.verify()
		if l.lifetime.failure == nil && l.ctx.Err() != nil {
			l.lifetime.failure = Unavailable
		}
	}
	return l.lifetime.failure
}

func (l *PreservationLease) Close() error {
	if l == nil || l.lifetime == nil {
		return nil
	}
	return l.lifetime.Close()
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

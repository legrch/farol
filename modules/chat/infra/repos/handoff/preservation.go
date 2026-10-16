package handoff

import (
	"context"
	"crypto/sha256"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
)

// PreservationInspection contains copied scalar/stage metadata for the complete
// canonical handoff chain, including nonempty recorded retirements. An empty
// chain has no persisted scope binding; the enclosing owner must independently
// bind its lifecycle. Stored stages never prove original drain/terminal custody,
// clean retirement, a live origin or permission to consume/open a successor.
type PreservationInspection struct {
	Scope                port.JournalScope
	ParentRoot, ChatRoot port.JournalRoot
	HeadDigest           [32]byte
	HeadStage            port.HandoffStage
	Stages               []ClosedInspectionStage
}

type PreservationLease struct {
	lifetime *ClosedLease
	value    PreservationInspection
	ctx      context.Context
}

func AcquirePreservationInspection(ctx context.Context, roots Roots, scope port.JournalScope) (*PreservationLease, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	until, bounded := ctx.Deadline()
	if !bounded || until.IsZero() || !historyID(roots.ProfileID) || !historyID(scope.BackendGeneration) || scope.ProfileID != roots.ProfileID {
		return nil, fail(Invalid, false)
	}
	bound := preservationContext{Context: ctx, until: until}
	if bound.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	return acquirePreservationInspection(bound, roots, scope)
}

func (l *PreservationLease) Observation() (PreservationInspection, error) {
	if l == nil || l.lifetime == nil || l.ctx == nil {
		return PreservationInspection{}, fail(Unavailable, false)
	}
	l.lifetime.mu.Lock()
	defer l.lifetime.mu.Unlock()
	if l.lifetime.closed || l.lifetime.failure != nil {
		return PreservationInspection{}, fail(Unavailable, false)
	}
	if l.ctx.Err() != nil {
		l.lifetime.failure = fail(Cancelled, false)
		return PreservationInspection{}, l.lifetime.failure
	}
	v := l.value
	v.Stages = append([]ClosedInspectionStage(nil), v.Stages...)
	return v, nil
}

func (l *PreservationLease) Verify() error {
	if l == nil || l.lifetime == nil {
		return fail(Unavailable, false)
	}
	return l.lifetime.Verify()
}

func (l *PreservationLease) Close() error {
	if l == nil || l.lifetime == nil {
		return nil
	}
	return l.lifetime.Close()
}

// Use the original complete canonical storage scanner through the existing
// no-write/no-poison facade. Do not reimplement transitions, weaken a writer or
// infer authority from the full nonempty retirement data it validates.
func preservationChainScan(ctx context.Context, roots Roots, read func(context.Context, int) ([]byte, bool, error)) (closedInspectionChain, error) {
	s := &owner{roots: roots, disk: closedInspectionReader{readRecord: read}}
	stages := make([]ClosedInspectionStage, 0)
	head, _, _, err := s.scanEach(ctx, func(r port.HandoffRecord) error {
		raw, err := encode(r)
		if err != nil {
			return err
		}
		stages = append(stages, ClosedInspectionStage{Index: len(stages) + 1, Stage: r.Stage, Digest: sha256.Sum256(raw)})
		return nil
	})
	if err != nil || head == nil {
		return closedInspectionChain{}, fail(Refused, false)
	}
	return closedInspectionChain{head: head, stages: stages}, nil
}

func preservationValue(roots Roots, scope port.JournalScope, chain closedInspectionChain) (PreservationInspection, error) {
	if chain.head == nil {
		return PreservationInspection{}, fail(Refused, false)
	}
	v := PreservationInspection{Scope: scope, ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity, HeadDigest: chain.head.Digest, Stages: append([]ClosedInspectionStage(nil), chain.stages...)}
	r := chain.head.Record
	if r == nil {
		if len(chain.stages) != 0 || chain.head.Digest != ([32]byte{}) {
			return PreservationInspection{}, fail(Refused, false)
		}
		return v, nil
	}
	binding := r.Publication.Binding
	current := port.JournalScope{ProfileID: binding.ProfileID, BackendGeneration: binding.BackendGeneration}
	if r.Stage == port.HandoffConsumed && r.Consumption != nil {
		current = r.Consumption.Next
	}
	if current != scope {
		return PreservationInspection{}, fail(Refused, false)
	}
	v.HeadStage = r.Stage
	return v, nil
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

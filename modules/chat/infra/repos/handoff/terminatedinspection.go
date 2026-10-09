package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
)

// AcquireTerminatedRetirementInspection retains the existing read-only claim
// over the entire canonical empty chain ending in the original scope's normal
// termination. The matching ACK and terminal are persisted observations, never
// reconstructed runtime acknowledgement, clean retirement or successor proof.
// Persisted terminal metadata does not attest that a process is currently closed.
// Observation is provisional until Verify; Close releases only owned descriptors.
// This capability cannot Consume, publish, recover, replace roots or admit work.
func AcquireTerminatedRetirementInspection(ctx context.Context, roots Roots, scope port.JournalScope) (*ClosedLease, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	if !historyID(roots.ProfileID) || !historyID(scope.BackendGeneration) || scope.ProfileID != roots.ProfileID {
		return nil, fail(Invalid, false)
	}
	return acquireTerminatedRetirementInspection(ctx, roots, scope)
}

// Only the shared scanner supplies chain: it validates canonical bytes, every
// adjacent transition (including the exact canonical ACK digest), root bindings,
// reuse and the complete empty prefix. This predicate selects no new lifetime.
func terminatedRetirementInspectionValue(roots Roots, scope port.JournalScope, chain closedInspectionChain) (ClosedInspection, error) {
	h := chain.head
	if h == nil || h.Record == nil || !h.EmptyRetirementChain {
		return ClosedInspection{}, fail(Refused, false)
	}
	r := h.Record
	b := r.Publication.Binding
	if policy.ValidateRecord(*r) != nil || r.Stage != port.HandoffTerminated || r.Consumption != nil ||
		(port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}) != scope ||
		scope.ProfileID != roots.ProfileID || b.ParentRoot != roots.Parent.Identity || b.ChatRoot != roots.Chat.Identity {
		return ClosedInspection{}, fail(Refused, false)
	}
	return ClosedInspection{Scope: scope, ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity,
		HeadDigest: h.Digest, HeadStage: r.Stage, Publication: r.Publication,
		Stages: append([]ClosedInspectionStage(nil), chain.stages...), Head: copyClosedInspectionHead(h)}, nil
}

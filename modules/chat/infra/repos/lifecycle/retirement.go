package lifecycle

import (
	"context"
	"crypto/sha256"
	"math"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

func (r Root) identity() port.JournalRoot {
	return port.JournalRoot{Device: r.Device, Inode: r.Inode, OwnerUID: r.OwnerUID}
}

// NewAfterRetirement consumes origin-qualified known-clean proof for the same
// profile/physical root. It qualifies the exact retained publication under the
// existing claim's exclusive lock. OpenFresh then publishes an EMPTY new scope,
// with no historical Handle, result body, positive current state or replay.
// Generic New still rejects every existing claim. Boot owns proof retention across
// process exit and must never manufacture this port from stored journal bytes.
func NewAfterRetirement(ctx context.Context, root Root, next port.JournalScope, limits Limits, origin port.CleanRetirement) (*Repository, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	if origin == nil || !validLimits(limits) || !validID(root.ProfileID) || !validID(next.BackendGeneration) || next.ProfileID != root.ProfileID {
		return nil, failure(Invalid, false)
	}
	proof, err := captureProof(ctx, origin)
	if err != nil || proof.Write.Scope.ProfileID != root.ProfileID || proof.Write.Root != root.identity() || proof.Write.Scope.BackendGeneration == next.BackendGeneration {
		return nil, failure(Refused, false)
	}
	d, err := openRetiredDisk(ctx, root)
	if err != nil {
		return nil, err
	}
	r := newOwner(root.ProfileID, limits, d, root.identity())
	if err := qualifySuccessor(ctx, r, next, proof); err != nil {
		if closeErr := r.Close(); closeErr != nil {
			return nil, failure(Unknown, true)
		}
		return nil, err
	}
	return r, nil
}

// No native IO occurs while the origin's live-owner gate is held.
func captureProof(ctx context.Context, origin port.CleanRetirement) (port.RetirementReceipt, error) {
	var proof port.RetirementReceipt
	calls := 0
	err := origin.WithRetirement(ctx, func(value *port.RetirementReceipt) error {
		calls++
		if calls != 1 || value == nil {
			return Invalid
		}
		proof = *value
		proof.Write = port.CopyRetirement(value.Write)
		return nil
	})
	if err != nil || ctx.Err() != nil || calls != 1 || proof.PublicationDigest == ([32]byte{}) || proof.Write.Root.Device == 0 || proof.Write.Root.Inode == 0 || proof.Write.PreviousRevision >= math.MaxUint64-1 || proof.Write.Revision != proof.Write.PreviousRevision+1 || proof.Write.Turns == nil {
		return port.RetirementReceipt{}, Invalid
	}
	return proof, nil
}

// Adapter-private entry also supports cheap protocol fixtures. Production always
// opens the qualified native root first and never accepts injected storage.
func qualifySuccessor(ctx context.Context, r *Repository, next port.JournalScope, proof port.RetirementReceipt) error {
	s := r.owner
	raw, err := s.disk.read(s.limits.Bytes)
	if err != nil {
		return s.storageFailure(err)
	}
	previous, err := decode(raw, s.limits)
	if err != nil || sha256.Sum256(raw) != proof.PublicationDigest || previous.Root != s.root || previous.Scope.ProfileID != s.profile || previous.Retirement == nil || !port.SameRetirement(*previous.Retirement, proof.Write) || next.ProfileID != s.profile || !validID(next.BackendGeneration) || len(previous.Incarnations) >= s.limits.Records {
		return s.reject(Refused, false)
	}
	for _, used := range previous.Incarnations {
		if used == next.BackendGeneration {
			return s.reject(Refused, false)
		}
	}
	if ctx.Err() != nil {
		return s.reject(Cancelled, false)
	}
	s.predecessor, s.digest, s.expectedScope = &previous, proof.PublicationDigest, next
	return nil
}

func (r *Repository) Retire(ctx context.Context, write port.RetirementWrite) (*port.RetirementReceipt, error) {
	if r == nil || r.owner == nil || ctx == nil {
		return nil, failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkContext(ctx); err != nil {
		return nil, err
	}
	if !s.opened || s.current.Retirement != nil || write.Scope != s.current.Scope || write.Root != s.root || write.PreviousRevision != uint64(len(s.current.Writes)) || write.PreviousRevision >= math.MaxUint64-1 || write.Revision != write.PreviousRevision+1 {
		return nil, s.reject(Refused, false)
	}
	visible, err := s.disk.read(s.limits.Bytes)
	if err != nil {
		return nil, s.storageFailure(err)
	}
	if sha256.Sum256(visible) != s.digest {
		return nil, s.reject(Unavailable, false)
	}
	candidate := s.current
	copy := port.CopyRetirement(write)
	candidate.Retirement = &copy
	raw, err := encode(candidate, s.limits)
	if err != nil {
		return nil, s.reject(Refused, false)
	}
	if err := s.disk.replace(ctx, raw, s.digest, s.limits.Bytes); err != nil {
		return nil, s.storageFailure(err)
	}
	visible, err = s.disk.read(s.limits.Bytes)
	if err != nil || sha256.Sum256(visible) != sha256.Sum256(raw) || ctx.Err() != nil {
		return nil, s.reject(Unknown, true)
	}
	// Known-clean retirement includes known release of this owner's descriptors.
	// Close errors leave published bytes but supply no receipt or new authority.
	s.closed = true
	if s.disk.close() != nil {
		s.closeErr = failure(Unknown, true)
		return nil, s.reject(Unknown, true)
	}
	if ctx.Err() != nil {
		return nil, s.reject(Unknown, true)
	}
	s.current, s.digest = candidate, sha256.Sum256(raw)
	return &port.RetirementReceipt{Write: port.CopyRetirement(write), PublicationDigest: s.digest}, nil
}

func validIncarnations(used []string, scope port.JournalScope, limits Limits) bool {
	if len(used) == 0 || len(used) > limits.Records || used[len(used)-1] != scope.BackendGeneration {
		return false
	}
	seen := make(map[string]bool, len(used))
	for _, id := range used {
		if !validID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

// Replayed transitions validate format ONLY. Exact original cleanup witnesses and
// revisions must match all live-owner evidence; no settled projection synthesizes
// a witness. The reconstructed queue/registry never escapes codec validation.
func validateRetirement(value record, limits Limits, proofs map[string]port.RetirementTurn, pending bool) error {
	if value.Retirement == nil {
		return nil
	}
	w := value.Retirement
	if pending || len(value.Writes)+1 > limits.Records || w.Scope != value.Scope || w.Root != value.Root || w.PreviousRevision != uint64(len(value.Writes)) || w.Revision != w.PreviousRevision+1 || w.Turns == nil || len(w.Turns) != len(proofs) {
		return Invalid
	}
	previousID := ""
	for _, actual := range w.Turns {
		id := actual.Binding.OperationID
		want, found := proofs[id]
		if !found || id <= previousID || actual != want {
			return Invalid
		}
		previousID = id
		view := want.Snapshot
		if !view.HasResult || view.Phase == turn.Unknown || view.Result.Outcome == turn.UnknownOutcome || !view.DeliveryAcknowledged || !view.LifecycleSettled || view.OutstandingCallID != "" || want.AcknowledgedRevision == 0 {
			return Invalid
		}
		if view.Reserved {
			if want.SettledRevision == 0 || want.ReleasedRevision == 0 || want.ReleasedRevision <= want.AcknowledgedRevision || want.ReleasedRevision <= want.SettledRevision {
				return Invalid
			}
			if view.Bound {
				if want.Quiescence.Binding != view.Binding || want.Quiescence.ResultID != view.Result.ID || !want.Quiescence.Confirmed || want.Quiescence.Sequence <= view.LastSequence || want.Disposal != (turn.DisposalEvidence{}) {
					return Invalid
				}
			} else if want.Disposal.Reservation != view.Reservation || want.Disposal.ResultID != view.Result.ID || !want.Disposal.Confirmed || want.Quiescence != (turn.QuiescenceEvidence{}) {
				return Invalid
			}
		} else if view.SendIntent || view.Result.Outcome != turn.CancelledOutcome || view.Result.Code != "NOT_DISPATCHED" || want.SettledRevision != 0 || want.ReleasedRevision != 0 || want.Quiescence != (turn.QuiescenceEvidence{}) || want.Disposal != (turn.DisposalEvidence{}) {
			return Invalid
		}
	}
	return nil
}

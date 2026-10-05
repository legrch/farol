package handoff

import (
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// This closed branch accepts only ordinary completed provider turns. Refused,
// failed, cancelled, unknown, unacknowledged or memory-only delivery remains
// outside the supported handoff. The actual origin supplies the receipt; native
// successor qualification still joins every field to the original journal.
func completedRetained(actual port.RetirementTurn, scope port.JournalScope, root port.JournalRoot, previousRevision uint64) bool {
	b, view := actual.Binding, actual.Snapshot
	if b.ProfileID != scope.ProfileID || b.BackendGeneration != scope.BackendGeneration || b.TaskEpoch == 0 || b.TurnGeneration == 0 {
		return false
	}
	for _, id := range []string{b.OwnerID, b.SessionID, b.TaskID, b.ParticipantID, b.TurnID, b.OperationID, view.Binding.Document.ViewID, view.Binding.Document.ConversationID} {
		if !validID(id) {
			return false
		}
	}
	i := turn.Identity{ProfileID: b.ProfileID, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TurnID: b.TurnID, OperationID: b.OperationID, Generation: b.TurnGeneration}
	r := view.Reservation
	if r.Identity != i || r.BackendGeneration != scope.BackendGeneration || r.Ordinal < 1 || r.Ordinal > turn.Slots || r.Generation == 0 || view.Binding.Reservation != r {
		return false
	}
	d := view.Binding.Document
	if d.ProviderState != turn.ProviderBound || d.ViewGeneration == 0 || d.DocumentGeneration == 0 {
		return false
	}
	if view.DeltaCount == 0 || view.LastSequence < view.DeltaCount {
		return false
	}
	want := turn.Snapshot{Identity: i, Phase: turn.Delivered, Reserved: true, Reservation: r, Bound: true, Binding: view.Binding,
		SendIntent: true, Accepted: true, DeltaCount: view.DeltaCount, LastSequence: view.LastSequence, HasResult: true,
		Result: turn.Result{ID: b.OperationID, Outcome: turn.Completed, Code: "PROVIDER_COMPLETED"}, DeliveryAcknowledged: true, LifecycleSettled: true}
	if view != want || actual.Disposal != (turn.DisposalEvidence{}) || !actual.Quiescence.Confirmed || actual.Quiescence.Binding != view.Binding || actual.Quiescence.ResultID != view.Result.ID || actual.Quiescence.Sequence <= view.LastSequence {
		return false
	}
	if actual.AcknowledgedRevision == 0 || actual.SettledRevision == 0 || actual.ReleasedRevision <= actual.AcknowledgedRevision || actual.ReleasedRevision <= actual.SettledRevision || actual.ReleasedRevision > previousRevision {
		return false
	}
	return actual.ResultPublication.Valid() && actual.ResultPublication.Root == root
}

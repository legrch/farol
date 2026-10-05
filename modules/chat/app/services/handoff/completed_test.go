package handoff

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Constructed hostile-record fixtures do not establish live origin, storage,
// actual browser cleanup, process terminal or host-drain evidence.
func completedReceipt(b port.HandoffBinding) port.RetirementReceipt {
	r := cancelledReceipt(b)
	a := &r.Write.Turns[0]
	slot := turn.Reservation{Identity: a.Snapshot.Identity, Ordinal: 1, Generation: 1, BackendGeneration: b.BackendGeneration}
	physical := turn.Binding{Reservation: slot, Document: turn.Document{ProviderState: turn.ProviderBound, ViewID: "view", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "provider-conversation"}}
	a.Snapshot = turn.Snapshot{Identity: slot.Identity, Phase: turn.Delivered, Reserved: true, Reservation: slot, Bound: true, Binding: physical, SendIntent: true, Accepted: true, DeltaCount: 1, LastSequence: 2, HasResult: true, Result: turn.Result{ID: a.Binding.OperationID, Outcome: turn.Completed, Code: "PROVIDER_COMPLETED"}, DeliveryAcknowledged: true, LifecycleSettled: true}
	a.AcknowledgedRevision, a.SettledRevision, a.ReleasedRevision = 10, 11, 12
	a.Quiescence = turn.QuiescenceEvidence{Binding: physical, ResultID: a.Binding.OperationID, Sequence: 4, Confirmed: true}
	a.ResultPublication = port.ResultPublication{Version: 1, Root: b.ChatRoot, StorageRoot: port.JournalRoot{Device: b.ChatRoot.Device, Inode: b.ChatRoot.Inode + 1, OwnerUID: b.ChatRoot.OwnerUID}, Digest: [32]byte{5}, EncodedBytes: 1024}
	r.Write.PreviousRevision, r.Write.Revision = 12, 13
	return r
}

func TestCompletedHandoffRequiresEveryDurableDeliveryBoundary(t *testing.T) {
	b := binding()
	for name, mutate := range map[string]func(*port.RetirementTurn){
		"valid":                       func(*port.RetirementTurn) {},
		"missing-reference":           func(r *port.RetirementTurn) { r.ResultPublication = port.ResultPublication{} },
		"crossed-root":                func(r *port.RetirementTurn) { r.ResultPublication.Root.Inode++ },
		"missing-digest":              func(r *port.RetirementTurn) { r.ResultPublication.Digest = [32]byte{} },
		"missing-storage":             func(r *port.RetirementTurn) { r.ResultPublication.StorageRoot = port.JournalRoot{} },
		"wrong-backend":               func(r *port.RetirementTurn) { r.Binding.BackendGeneration = "other" },
		"missing-epoch":               func(r *port.RetirementTurn) { r.Binding.TaskEpoch = 0 },
		"no-send":                     func(r *port.RetirementTurn) { r.Snapshot.SendIntent = false },
		"no-accept":                   func(r *port.RetirementTurn) { r.Snapshot.Accepted = false },
		"no-delta":                    func(r *port.RetirementTurn) { r.Snapshot.DeltaCount = 0 },
		"unknown":                     func(r *port.RetirementTurn) { r.Snapshot.Result.Outcome = turn.UnknownOutcome },
		"refused":                     func(r *port.RetirementTurn) { r.Snapshot.Result.Outcome = turn.Refused },
		"wrong-result":                func(r *port.RetirementTurn) { r.Snapshot.Result.ID = "other" },
		"wrong-code":                  func(r *port.RetirementTurn) { r.Snapshot.Result.Code = "COMPLETED" },
		"not-delivered":               func(r *port.RetirementTurn) { r.Snapshot.Phase = turn.ResultReady },
		"no-ack":                      func(r *port.RetirementTurn) { r.Snapshot.DeliveryAcknowledged = false },
		"no-settlement":               func(r *port.RetirementTurn) { r.Snapshot.LifecycleSettled = false },
		"no-cleanup":                  func(r *port.RetirementTurn) { r.Quiescence.Confirmed = false },
		"stale-cleanup":               func(r *port.RetirementTurn) { r.Quiescence.Sequence = r.Snapshot.LastSequence },
		"crossed-cleanup":             func(r *port.RetirementTurn) { r.Quiescence.Binding.Document.DocumentGeneration++ },
		"home":                        func(r *port.RetirementTurn) { r.Snapshot.Binding.Document.ProviderState = turn.ProviderHome },
		"legacy-unqualified-document": func(r *port.RetirementTurn) { r.Snapshot.Binding.Document.ProviderState = "" },
		"crossed-reservation":         func(r *port.RetirementTurn) { r.Snapshot.Reservation.Ordinal = turn.Slots },
		"outstanding-tool":            func(r *port.RetirementTurn) { r.Snapshot.OutstandingCallID = "call" },
		"missing-ack-revision":        func(r *port.RetirementTurn) { r.AcknowledgedRevision = 0 },
		"crossed-ack-revision":        func(r *port.RetirementTurn) { r.AcknowledgedRevision = r.SettledRevision },
		"release-before-ack":          func(r *port.RetirementTurn) { r.ReleasedRevision = r.AcknowledgedRevision },
		"release-before-cleanup":      func(r *port.RetirementTurn) { r.ReleasedRevision = r.SettledRevision },
		"release-after-retirement":    func(r *port.RetirementTurn) { r.ReleasedRevision++ },
		"stale-disposal":              func(r *port.RetirementTurn) { r.Disposal.ResultID = "result" },
	} {
		t.Run(name, func(t *testing.T) {
			r := completedReceipt(b)
			mutate(&r.Write.Turns[0])
			store := &memoryStore{}
			service, _ := New(store)
			p, err := service.Capture(context.Background(), b, "handoff", &fixtureOrigin{receipt: r})
			if name == "valid" {
				if err != nil || p == nil || store.calls != 1 {
					t.Fatal("known complete receipt refused", err)
				}
			} else if err == nil || p != nil || store.calls != 0 {
				t.Fatal("unsafe receipt published", err)
			}
		})
	}
}

func TestCompletedAndNeverDispatchedRegistryKeepsDistinctCleanupRevisions(t *testing.T) {
	b := binding()
	r := completedReceipt(b)
	cancelled := cancelledReceipt(b).Write.Turns[0]
	cancelled.Binding.OperationID, cancelled.Binding.TurnID = "z-cancelled", "cancelled-turn"
	cancelled.Snapshot.Identity.OperationID, cancelled.Snapshot.Identity.TurnID = cancelled.Binding.OperationID, cancelled.Binding.TurnID
	cancelled.AcknowledgedRevision = 15
	r.Write.Turns = append(r.Write.Turns, cancelled)
	r.Write.PreviousRevision, r.Write.Revision = 15, 16
	for _, overlap := range []bool{false, true} {
		copy := r
		copy.Write = port.CopyRetirement(r.Write)
		if overlap {
			copy.Write.Turns[1].AcknowledgedRevision = copy.Write.Turns[0].SettledRevision
		}
		store := &memoryStore{}
		service, _ := New(store)
		p, err := service.Capture(context.Background(), b, "handoff", &fixtureOrigin{receipt: copy})
		if !overlap {
			if p == nil || err != nil {
				t.Fatal("mixed clean registry refused", err)
			}
		} else if p != nil || err == nil || store.calls != 0 {
			t.Fatal("overlapping cleanup revisions accepted")
		}
	}
}

func TestCompletedHandoffUsesActualOneBasedWorkerOrdinals(t *testing.T) {
	for _, ordinal := range []uint8{0, 1, turn.Slots, turn.Slots + 1} {
		r := completedReceipt(binding())
		a := &r.Write.Turns[0]
		a.Snapshot.Reservation.Ordinal = ordinal
		a.Snapshot.Binding.Reservation.Ordinal = ordinal
		a.Quiescence.Binding.Reservation.Ordinal = ordinal
		store := &memoryStore{}
		service, _ := New(store)
		p, err := service.Capture(context.Background(), binding(), "handoff", &fixtureOrigin{receipt: r})
		valid := ordinal >= 1 && ordinal <= turn.Slots
		if valid && (err != nil || p == nil || store.calls != 1) {
			t.Errorf("real worker %d refused: %v", ordinal, err)
		}
		if !valid && (err == nil || p != nil || store.calls != 0) {
			t.Errorf("invalid worker %d accepted", ordinal)
		}
	}
}

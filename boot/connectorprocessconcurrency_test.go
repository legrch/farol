package boot

import (
	"context"
	"errors"
	"testing"

	processct "github.com/legrch/farol/modules/computer/contracts/process"
)

// The existing native double's Cancel hook defines an exact in-flight
// interleaving. No timing, native process, endpoint or provider is involved.
func TestConnectorProcessCancelOwnerChangeCannotRepairLostACK(t *testing.T) {
	for _, change := range []string{"revision", "root-unknown", "reconnect"} {
		t.Run(change, func(t *testing.T) {
			s, journal, child, launch := processWireFixture(t)
			start := processWireStarted(t, s)
			originalSlot := s.current
			revision := s.root.guard.revision
			child.cancelIO = func() {
				switch change {
				case "revision":
					s.root.guard.mu.Lock()
					s.root.guard.revision++
					s.root.guard.mu.Unlock()
				case "root-unknown":
					s.root.mu.Lock()
					s.root.unknown = true
					s.root.mu.Unlock()
				case "reconnect":
					if err := s.closeSlot(context.Background()); err != nil {
						t.Fatal(err)
					}
					if _, err := s.Open(context.Background(), "cancel-successor", launch); err != nil {
						t.Fatal(err)
					}
				}
			}
			out, err := s.cancelProcess(context.Background(), originalSlot, "cancel-original", start.OperationId, start.Handle)
			var failure *processct.Failure
			if out != nil || !errors.As(err, &failure) || failure.Outcome != "outcome_unknown" || failure.Retry != "never" || child.cancels != 1 {
				t.Fatal("late owner change disclosed original ACK", out, err)
			}
			// Restore the fixture's root fences. The original control attempt
			// remains consumed even if the surrounding authority looks healthy.
			s.root.guard.mu.Lock()
			s.root.guard.revision = revision
			s.root.guard.mu.Unlock()
			s.root.mu.Lock()
			s.root.unknown = false
			s.root.mu.Unlock()
			child.cancelIO = nil
			if out, err := s.cancelProcess(context.Background(), originalSlot, "cancel-after-repair", start.OperationId, start.Handle); out != nil || !errors.As(err, &failure) || failure.Outcome != "outcome_unknown" || child.cancels != 1 {
				t.Fatal("authority repair replayed or repaired lost ACK", out, err)
			}
			if change != "reconnect" {
				if err := s.closeSlot(context.Background()); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Open(context.Background(), "cancel-successor", launch); err != nil {
					t.Fatal(err)
				}
			}
			if s.current == originalSlot || s.current.guard.host != originalSlot.guard.host {
				t.Fatal("fixture did not create a distinct connector with identical host metadata")
			}
			if out, err := s.cancelProcess(context.Background(), s.current, "cancel-reconnected", start.OperationId, start.Handle); out != nil || err == nil || err.Error() != "PROCESS_CONTROL_LIFETIME_MISMATCH" || child.cancels != 1 {
				t.Fatal("reconnected slot adopted uncertain control", out, err)
			}
			if out, err := s.observeProcess(context.Background(), s.current, start.OperationId, processct.ReadRequest{Handle: start.Handle}); out != nil || !errors.As(err, &failure) || failure.Outcome != "outcome_unknown" || child.reads != 0 {
				t.Fatal("fresh admitted READ cleared lost cancellation ACK", out, err)
			}
			child.terminal = true
			close(child.completed)
			awaitProcessCollection(t, s, start.OperationId)
			record := s.mutations.operations[start.OperationId]
			if !record.process.cancelUnknown || record.settled || record.process.collectionErr == nil || child.reads != 0 ||
				child.spawns != 1 || journal.reserves != 1 || s.drainProcessesForRetirement(context.Background()) == nil {
				t.Fatal("later root completion erased uncertainty or repeated execution")
			}
		})
	}
}

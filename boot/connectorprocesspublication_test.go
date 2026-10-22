package boot

import (
	"context"
	"strings"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
)

// Reuse the actual collector, connector admission and observation owners. The
// repository and physical workspace are memory doubles: the cold lifetime below
// qualifies their composition, not disk durability, native reconnect or launch.
func TestConnectorProcessPublicationReconnectAndColdLifetimeKeepOriginal(t *testing.T) {
	s, access, journal, child, input := connectorProcessFixture(t)
	originalSlot := s.current
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	intent, scope := journal.intent, journal.scope
	child.terminal, child.supervisor = true, processsvc.SupervisorExited
	// Replace the admitted connector after the original bytes were captured,
	// while publication still has no ACK. Completion remains backend-owned.
	publisher.after = func() {
		input.RuntimeId, input.ConnectorGeneration = "publication-successor", "9007199254740994"
		selectConnectorProcessSlot(t, s, access, input, "publication-successor")
	}
	collectionDone := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, collectionDone)
	if publisher.publishes != 1 || publisher.result == nil || publisher.result.Scope != scope || publisher.result.Intent != intent ||
		!s.mutations.operations[start.OperationID].settled || s.current == originalSlot {
		t.Fatal("connector replacement lost original publication or provenance")
	}
	request := processct.ReadRequest{Handle: start.Handle}
	out, err := s.observeProcess(context.Background(), s.current, start.OperationID, request)
	if err != nil || out == nil || out.State != processct.Exited || out.StdoutBase64 != "c2F2ZWQ=" || out.StderrBase64 != "ZXJy" ||
		out.ExitCode == nil || *out.ExitCode != 7 || out.GroupCleanup != processct.CleanupUnverified || out.DescendantCleanup != processct.CleanupUnverified {
		t.Fatal("admitted successor lost retained output or promoted cleanup", out, err)
	}
	if out, err := s.observeProcess(context.Background(), originalSlot, start.OperationID, request); out != nil || err == nil {
		t.Fatal("publication restored original disclosure")
	}
	if out, err := s.cancelProcess(context.Background(), s.current, "successor-cancel", start.OperationID, start.Handle); out != nil || err == nil || err.Error() != "PROCESS_CONTROL_LIFETIME_MISMATCH" {
		t.Fatal("successor adopted original control", out, err)
	}
	if journal.reserves != 1 || child.spawns != 1 || child.reads != 2 || publisher.publishes != 1 {
		t.Fatal("reconnect repeated execution, capture or publication")
	}
	// Use exactly the collector's published value, rather than a separately
	// fabricated terminal. The independent root has no operation or child owner.
	cold, store, physical, current, coldRequest := storedProcessFixture(t)
	value := publisher.result.Clone()
	store.value = &value
	coldOut, err := readStoredFixture(cold, current, physical, coldRequest)
	if err != nil || coldOut == nil || coldOut.StdoutBase64 != out.StdoutBase64 || coldOut.StderrBase64 != out.StderrBase64 ||
		coldOut.State != out.State || coldOut.Supervisor != out.Supervisor || coldOut.GroupCleanup != out.GroupCleanup ||
		coldOut.DescendantCleanup != out.DescendantCleanup || coldOut.ExitCode == nil || *coldOut.ExitCode != *out.ExitCode {
		t.Fatal("cold root changed the published original result", coldOut, err)
	}
	if out, err := cold.cancelProcess(context.Background(), cold.current, "cold-cancel", start.OperationID, start.Handle); out != nil || err == nil || err.Error() != "PROCESS_UNAVAILABLE" {
		t.Fatal("cold result reconstructed control", out, err)
	}
	physical.seal.RootIdentity.Inode = "9"
	if out, err := readStoredFixture(cold, current, physical, coldRequest); out != nil || err == nil {
		t.Fatal("cold saved bytes bypassed a changed physical root", out, err)
	}
	if store.loads != 2 || store.reserves != 0 || physical.spawns != 0 || physical.reads != 0 || len(cold.mutations.operations) != 0 {
		t.Fatal("cold read recreated execution or settlement")
	}
}

func TestConnectorProcessPublicationAuthorityChangesDoNotLosePrivateResult(t *testing.T) {
	for _, change := range []string{"withdrawal", "generation", "physical-root"} {
		t.Run(change, func(t *testing.T) {
			s, access, journal, child, _ := connectorProcessFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
			s.mutations.dependencies.repository = publisher
			start := startConnectorProcessFixture(t, s, child)
			intent, scope := journal.intent, journal.scope
			child.terminal, child.supervisor = true, processsvc.SupervisorExited
			publisher.after = func() {
				switch change {
				case "withdrawal":
					s.current.guard.close()
				case "generation":
					access.approval.Generation++
					access.PutApproval(access.approval)
				case "physical-root":
					child.seal.RootIdentity.Inode = "9"
				}
			}
			collectionDone := processCollectionDone(s, start.OperationID)
			close(child.completed)
			awaitProcessCollectionDone(t, collectionDone)
			if publisher.result == nil || publisher.result.Scope != scope || publisher.result.Intent != intent ||
				string(publisher.result.Observation.Stdout) != "saved" || !s.mutations.operations[start.OperationID].settled {
				t.Fatal("late READ fence discarded private original output")
			}
			if out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil {
				t.Fatal("private retention bypassed current authority or physical root", out, err)
			}
			if publisher.publishes != 1 || child.reads != 1 || child.spawns != 1 || journal.reserves != 1 ||
				s.drainProcessesForRetirement(context.Background()) != nil || s.mutations.freezeForRetirement() != nil {
				t.Fatal("READ refusal tainted known publication or repeated an effect")
			}
		})
	}
}

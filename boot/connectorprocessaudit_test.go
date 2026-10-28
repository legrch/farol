package boot

import (
	"errors"
	"strings"
	"testing"
)

func TestProcessTerminalAuditReadsOnlyOriginalPublishedFacts(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	build, runtime := journal.scope.Host.BuildID, journal.scope.Host.RuntimeID
	if _, ok := s.processTerminalAudit(start.OperationID, build, runtime); ok {
		t.Fatal("running result was projected")
	}
	child.terminal = true
	done := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	audit, ok := s.processTerminalAudit(start.OperationID, build, runtime)
	if !ok || audit.OperationID != start.OperationID || audit.BuildID != build || audit.RuntimeID != runtime || !audit.RootWaited || !audit.OutputDrained {
		t.Fatal("original terminal facts unavailable")
	}
	for _, candidate := range [][3]string{{"other", build, runtime}, {start.OperationID, "other", runtime}, {start.OperationID, build, "other"}} {
		if _, ok := s.processTerminalAudit(candidate[0], candidate[1], candidate[2]); ok {
			t.Fatal("foreign reference disclosed facts")
		}
	}
	if child.spawns != 1 || publisher.publishes != 1 {
		t.Fatal("observation retried an effect")
	}
}

func TestProcessTerminalAuditDoesNotPromoteLostPublication(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64), err: errors.New("ack lost")}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	child.terminal = true
	done := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	if _, ok := s.processTerminalAudit(start.OperationID, journal.scope.Host.BuildID, journal.scope.Host.RuntimeID); ok {
		t.Fatal("lost publication acknowledgement was promoted")
	}
}

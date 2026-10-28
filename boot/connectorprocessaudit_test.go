package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
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

func TestProcessAuditHostMethodDoesNotDiscloseRawOutput(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	child.terminal = true
	done := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	request := wire.ComputerProcessAuditRequest{OperationId: start.OperationID, BuildId: journal.scope.Host.BuildID, RuntimeId: journal.scope.Host.RuntimeID}
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.processAuditMethod().Handle(context.Background(), desktop.Request{Body: body})
	if err != nil || out.Status != "ok" || wire.Validate("ComputerProcessAuditResult", out.Data) != nil || strings.Contains(string(out.Data), "saved") || strings.Contains(string(out.Data), "err") {
		t.Fatal("invalid audit response or disclosure", err)
	}
	var result wire.ComputerProcessAuditResult
	if json.Unmarshal(out.Data, &result) != nil || result.State != "observed" || result.Fact == nil || result.Fact.OperationId != start.OperationID {
		t.Fatal("missing original audit observation")
	}
	request.RuntimeId = "other"
	body, _ = json.Marshal(request)
	out, err = s.processAuditMethod().Handle(context.Background(), desktop.Request{Body: body})
	result = wire.ComputerProcessAuditResult{}
	if err != nil || json.Unmarshal(out.Data, &result) != nil || result.State != "not_observed" || result.Fact != nil {
		t.Fatal("foreign runtime was disclosed")
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

package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/services/output"
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
	if err != nil || out.Status != "ok" || wire.Validate("ComputerProcessAuditResult", out.Data) != nil || strings.Contains(string(out.Data), `"text":"saved"`) || strings.Contains(string(out.Data), `"text":"err"`) {
		t.Fatal("invalid audit response or disclosure", err)
	}
	var result wire.ComputerProcessAuditResult
	if json.Unmarshal(out.Data, &result) != nil || result.State != "observed" || result.Fact == nil || result.Fact.OperationId != start.OperationID || result.Fact.AuditDetails == nil || result.Fact.AuditDetails.Stdout.State != "unavailable" {
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

func TestProcessAuditProjectsOriginalDetailsOnce(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	calls := 0
	s.auditFilter = func(value string) (string, error) { calls++; return value, nil }
	command := output.ProjectCommand("git status", s.auditFilter)
	start, err := s.startProcessWithAudit(context.Background(), s.current, "audit-process", "call", child.selectLaunch, command)
	if err != nil || start == nil {
		t.Fatal("process did not start")
	}
	child.terminal = true
	done := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	first, ok := s.processTerminalAuditDetails(context.Background(), start.OperationID, journal.scope.Host.BuildID, journal.scope.Host.RuntimeID)
	if !ok || first.Command.Text != "git status" || first.Stdout.Text != "saved" || first.Stderr.Text != "err" {
		t.Fatal("missing filtered process details")
	}
	after := calls
	second, ok := s.processTerminalAuditDetails(context.Background(), start.OperationID, journal.scope.Host.BuildID, journal.scope.Host.RuntimeID)
	if !ok || second != first || calls != after || child.spawns != 1 {
		t.Fatal("observation was repeated")
	}
	if _, ok := s.processTerminalAuditDetails(context.Background(), start.OperationID, journal.scope.Host.BuildID, "foreign"); ok {
		t.Fatal("foreign runtime disclosed details")
	}
}

func TestSlowAuditFilterDoesNotHoldExecutionOrTerminalObservation(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	gate := make(chan struct{})
	s.auditFilter = func(value string) (string, error) { <-gate; return value, nil }
	t.Cleanup(func() { close(gate) })
	startAt := time.Now()
	command := s.auditCommandProjection(context.Background(), "private input")
	if time.Since(startAt) > time.Second {
		t.Fatal("slow command filter held execution")
	}
	start, err := s.startProcessWithAudit(context.Background(), s.current, "slow-audit", "call", child.selectLaunch, command)
	if err != nil || start == nil {
		t.Fatal("slow filter prevented process start")
	}
	child.terminal = true
	done := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	startAt = time.Now()
	_, ok := s.processTerminalAuditDetails(context.Background(), start.OperationID, journal.scope.Host.BuildID, journal.scope.Host.RuntimeID)
	if ok || time.Since(startAt) > time.Second {
		t.Fatal("slow filter held terminal observation")
	}
	if _, ok := s.processTerminalAudit(start.OperationID, journal.scope.Host.BuildID, journal.scope.Host.RuntimeID); !ok {
		t.Fatal("slow filter hid terminal metadata")
	}
}

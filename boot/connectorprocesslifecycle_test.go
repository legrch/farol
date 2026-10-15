package boot

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	processct "github.com/legrch/farol/modules/computer/contracts/process"
)

// These are actual root/service/connector owners with a controlled child and
// repository. Completion notifications and terminal facts are explicit fixtures;
// no process, native storage, application launch or external caller is exercised.
func awaitProcessCollection(t *testing.T, s *computerConnector, operation string) {
	t.Helper()
	awaitProcessCollectionDone(t, processCollectionDone(s, operation))
}

// Snapshot before releasing a controlled child so the wait cannot contend with
// the publisher's out-of-gate checks after completion or an original cancel ACK.
func processCollectionDone(s *computerConnector, operation string) <-chan struct{} {
	s.mutations.mu.Lock()
	done := s.mutations.operations[operation].process.collectionDone
	s.mutations.mu.Unlock()
	return done
}

func awaitProcessCollectionDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("original process collection did not complete")
	}
}

func TestConnectorProcessLifecycleRetainsAfterOriginalConnectorClosed(t *testing.T) {
	s, access, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	ctx, cancel := context.WithCancel(context.Background())
	start, err := s.startProcess(ctx, s.current, "process-operation", "process-call", child.selectLaunch)
	if err != nil {
		t.Fatal(err)
	}
	originalSlot := s.current
	cancel() // The original MCP request is finished, not the owning backend.
	access.clock.now = access.clock.now.Add(time.Minute)
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	child.terminal = true
	close(child.completed)
	awaitProcessCollection(t, s, start.OperationID)
	if publisher.publishes != 1 || publisher.result == nil || child.reads != 1 || child.probes != 0 || child.spawns != 1 || journal.reserves != 1 {
		t.Fatal("lifecycle did not retain exact original output without new effects or READ authority")
	}
	if publisher.result.Scope != journal.scope || publisher.result.Intent != journal.intent || string(publisher.result.Observation.Stdout) != "saved" {
		t.Fatal("original result changed")
	}
	if out, err := s.observeProcess(context.Background(), originalSlot, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil {
		t.Fatal("private retention restored old disclosure authority")
	}
	if s.drainProcessesForRetirement(context.Background()) != nil || s.mutations.freezeForRetirement() != nil {
		t.Fatal("known result cannot retire")
	}
}

func TestConnectorProcessLifecycleReadDoesNotTriggerPublication(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	child.terminal = true
	if out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle}); err != nil || out.State != processct.Terminal {
		t.Fatal("controlled terminal read failed", err)
	}
	if publisher.publishes != 0 || s.mutations.operations[start.OperationID].settled {
		t.Fatal("READ published or settled original process")
	}
	close(child.completed)
	awaitProcessCollection(t, s, start.OperationID)
	if publisher.publishes != 1 || !s.mutations.operations[start.OperationID].settled {
		t.Fatal("completion did not publish independently")
	}
}

func TestConnectorProcessLifecycleLostStartDisclosureRetainsOriginal(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	child.afterSpawn = func() { s.current.guard.close() }
	start, err := s.startProcess(context.Background(), s.current, "process-operation", "process-call", child.selectLaunch)
	if start != nil || err == nil || child.spawns != 1 {
		t.Fatal("fixture did not lose original disclosure")
	}
	var failure *processct.Failure
	if !errors.As(err, &failure) || failure.Code != "PROCESS_OUTCOME_UNKNOWN" || failure.Outcome != "outcome_unknown" || failure.Retry != "never" {
		t.Fatal("dispatched process was classified as refused", err)
	}
	outcome, outcomeErr := connectorProcessOutcome(nil, err)
	if outcomeErr != nil || outcome.Status != "unknown" || outcome.Code != "PROCESS_OUTCOME_UNKNOWN" {
		t.Fatal("wire lost the original execution uncertainty", outcome, outcomeErr)
	}
	child.terminal = true
	close(child.completed)
	awaitProcessCollection(t, s, "process-operation")
	if publisher.publishes != 1 || publisher.result == nil || !s.mutations.operations["process-operation"].settled || child.spawns != 1 || journal.reserves != 1 {
		t.Fatal("lost disclosure forgot child or repeated execution")
	}
}

func TestConnectorProcessLifecycleUnknownNeverRetiresOrReplays(t *testing.T) {
	for _, fault := range []string{"completion", "read", "lost-ack", "late-lifetime", "bad-digest"} {
		t.Run(fault, func(t *testing.T) {
			s, _, journal, child, _ := connectorProcessFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
			s.mutations.dependencies.repository = publisher
			start := startConnectorProcessFixture(t, s, child)
			child.terminal = true
			switch fault {
			case "completion":
				child.completionErr = errors.New("unknown completion")
			case "read":
				child.readErr = errors.New("unknown original output")
			case "lost-ack":
				publisher.err = errors.New("saved bytes with lost ACK")
			case "late-lifetime":
				publisher.after = s.cancel
			case "bad-digest":
				publisher.digest = "invalid"
			}
			close(child.completed)
			awaitProcessCollection(t, s, start.OperationID)
			if s.mutations.operations[start.OperationID].settled || s.mutations.operations[start.OperationID].process.collectionErr == nil {
				t.Fatal("unknown collection became settlement")
			}
			published := publisher.publishes
			child.completionErr, child.readErr, publisher.err, publisher.after = nil, nil, nil, nil
			publisher.digest = strings.Repeat("a", 64)
			if out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil {
				t.Fatal("fresh live read erased collection uncertainty")
			}
			if s.drainProcessesForRetirement(context.Background()) == nil || s.mutations.freezeForRetirement() == nil || publisher.publishes != published || child.spawns != 1 || journal.reserves != 1 {
				t.Fatal("unknown retried, retired or repeated execution")
			}
		})
	}
}

type processDrainContext struct {
	context.Context
	once    sync.Once
	entered chan struct{}
}

func (c *processDrainContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

func TestConnectorProcessLifecycleRetirementWaitsForKnownPublication(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64), after: func() { close(entered); <-release }}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	child.terminal = true
	close(child.completed)
	<-entered
	ctx := &processDrainContext{Context: context.Background(), entered: make(chan struct{})}
	drained := make(chan error, 1)
	go func() { drained <- s.drainProcessesForRetirement(ctx) }()
	<-ctx.entered
	if _, err := s.startProcess(context.Background(), s.current, "another-process", "another-call", child.selectLaunch); err == nil || child.spawns != 1 {
		t.Error("retirement allowed another process")
	}
	select {
	case <-drained:
		t.Error("retirement crossed publication without ACK")
	default:
	}
	close(release)
	if err := <-drained; err != nil {
		t.Fatal(err)
	}
	awaitProcessCollection(t, s, start.OperationID)
	if publisher.publishes != 1 || s.mutations.freezeForRetirement() != nil {
		t.Fatal("known final ACK failed retirement")
	}
}

func TestConnectorProcessLifecycleUncompletedQuitRemainsFenced(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s.drainProcessesForRetirement(ctx) == nil || s.mutations.freezeForRetirement() == nil || child.spawns != 1 {
		t.Fatal("uncompleted child retired or was replayed")
	}
	child.terminal = true
	close(child.completed)
	awaitProcessCollection(t, s, start.OperationID)
	if publisher.publishes != 0 || s.drainProcessesForRetirement(context.Background()) == nil || s.mutations.freezeForRetirement() == nil {
		t.Fatal("late terminal facts erased original failed retirement")
	}
}

// Isolate the test waiter's notification selection and gate behavior. The
// completion channel is controlled here; no collector or native child runs.
func TestConnectorProcessLifecycleCollectionWaitUsesOriginalNotification(t *testing.T) {
	originalDone := make(chan struct{})
	s := &computerConnector{mutations: &SettingsMutationIngress{
		operations: map[string]*settingsMutationOperation{
			"process-operation": {process: &connectorProcessOperation{collectionDone: originalDone}},
		},
	}}
	done := processCollectionDone(s, "process-operation")
	if done != originalDone {
		t.Fatal("waiter did not select the original collection notification")
	}
	select {
	case <-done:
		t.Fatal("collection notification completed before selection")
	default:
	}
	// Keep the ledger gate held through the entire wait and completion. A late
	// ledger acquisition by the waiter would prevent it from returning.
	s.mutations.mu.Lock()
	defer s.mutations.mu.Unlock()
	waited := make(chan struct{})
	go func() {
		defer close(waited)
		awaitProcessCollectionDone(t, done)
	}()
	close(originalDone)
	select {
	case <-waited:
	case <-time.After(2 * time.Second):
		t.Fatal("collection waiter acquired the ledger gate")
	}
}

func TestConnectorProcessLifecycleWaitsForOriginalCancelACK(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "known", true: "unknown"}[unknown], func(t *testing.T) {
			s, journal, child, _ := processWireFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
			s.mutations.dependencies.repository = publisher
			start := processWireStarted(t, s)
			done := processCollectionDone(s, start.OperationId)
			entered, release := make(chan struct{}), make(chan struct{})
			child.cancelIO = func() { close(entered); <-release }
			if unknown {
				child.cancelErr = errors.New("lost original cancel ACK")
			}
			type cancelResult struct {
				out *processct.CancelResponse
				err error
			}
			cancelled := make(chan cancelResult, 1)
			go func() {
				out, err := s.cancelProcess(context.Background(), s.current, "cancel-lifecycle", start.OperationId, start.Handle)
				cancelled <- cancelResult{out, err}
			}()
			<-entered
			child.terminal = true
			close(child.completed)
			close(release)
			result := <-cancelled
			awaitProcessCollectionDone(t, done)
			if (result.err != nil) != unknown || child.cancels != 1 || child.spawns != 1 || journal.reserves != 1 {
				t.Fatal("original control outcome changed or repeated", result.err)
			}
			if unknown {
				if publisher.publishes != 0 || s.mutations.operations[start.OperationId].settled || s.drainProcessesForRetirement(context.Background()) == nil {
					t.Fatal("unknown cancel was upgraded by terminal output")
				}
			} else if publisher.publishes != 1 || result.out == nil || result.out.Status != processct.CancelRequested || s.drainProcessesForRetirement(context.Background()) != nil {
				t.Fatal("known original cancel failed terminal retention")
			}
		})
	}
}

package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
)

// These controlled child/repository values exercise the actual collector and
// current read guards; they do not qualify a native supervisor or public Shell.
func TestConnectorSupervisedResultPreservesFactsWithoutSettlingUnknownGroup(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	child.terminal, child.supervisor = true, processsvc.SupervisorExited
	collectionDone := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, collectionDone)
	if publisher.publishes != 1 || publisher.result == nil || processsvc.ResultState(*publisher.result) != processsvc.Exited ||
		publisher.result.Observation.GroupCleanup != processsvc.CleanupUnverified || publisher.result.Observation.DescendantCleanup != processsvc.CleanupUnverified ||
		string(publisher.result.Observation.Stdout) != "saved" || child.spawns != 1 || journal.reserves != 1 || child.probes != 0 {
		t.Fatal("original supervised result was lost, replayed or promoted")
	}
	if s.drainProcessesForRetirement(context.Background()) == nil || s.mutations.freezeForRetirement() == nil {
		t.Fatal("known supervisor publication settled unverified group cleanup")
	}
}

func TestConnectorSupervisedResultUnknownCannotRetire(t *testing.T) {
	for _, fault := range []string{"supervisor-unknown", "supervisor-running", "completion", "publication"} {
		t.Run(fault, func(t *testing.T) {
			s, _, journal, child, _ := connectorProcessFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
			s.mutations.dependencies.repository = publisher
			start := startConnectorProcessFixture(t, s, child)
			child.terminal, child.supervisor = true, processsvc.SupervisorExited
			switch fault {
			case "supervisor-unknown":
				child.supervisor = processsvc.SupervisorUnknown
			case "supervisor-running":
				child.supervisor = processsvc.SupervisorRunning
			case "completion":
				child.completionErr = errors.New("unknown completion")
			case "publication":
				publisher.err = errors.New("lost original publication ACK")
			}
			collectionDone := processCollectionDone(s, start.OperationID)
			close(child.completed)
			awaitProcessCollectionDone(t, collectionDone)
			published := publisher.publishes
			child.supervisor, child.completionErr, publisher.err = processsvc.SupervisorExited, nil, nil
			if out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil {
				t.Fatal("fresh read erased an unknown original result")
			}
			if s.drainProcessesForRetirement(context.Background()) == nil || s.mutations.freezeForRetirement() == nil || publisher.publishes != published || child.spawns != 1 || journal.reserves != 1 {
				t.Fatal("unknown completion retired or replayed")
			}
		})
	}
}

func TestConnectorSupervisedResultColdReadPreservesCleanupAndCurrentAuthority(t *testing.T) {
	s, store, physical, current, request := storedProcessFixture(t)
	store.value.Observation.Supervisor = processsvc.SupervisorExited
	store.value.Observation.GroupCleanup, store.value.Observation.DescendantCleanup = processsvc.CleanupUnverified, processsvc.CleanupUnverified
	out, err := readStoredFixture(s, current, physical, request)
	if err != nil || out == nil || out.State != processct.Exited || out.Supervisor != processct.SupervisorExited ||
		out.GroupCleanup != processct.CleanupUnverified || out.DescendantCleanup != processct.CleanupUnverified || out.StdoutBase64 != "c2F2ZWQ=" || *out.ExitCode != 7 {
		t.Fatal("retained result lost its independent cleanup facts", out, err)
	}
	s.current.guard.close()
	if out, err := readStoredFixture(s, current, physical, request); out != nil || err == nil || store.loads != 1 {
		t.Fatal("stored result restored withdrawn READ authority")
	}
	if physical.spawns != 0 || physical.reads != 0 || store.reserves != 0 || len(s.mutations.operations) != 0 {
		t.Fatal("cold read recreated execution or settlement")
	}
}

func TestConnectorSupervisedResultWireKeepsIndependentStates(t *testing.T) {
	s, _, child, _ := processWireFixture(t)
	processWireStarted(t, s)
	child.terminal, child.supervisor = true, processsvc.SupervisorExited
	out := connectorMutationInvoke(t, s, "computer.process.read", "", processWireRead(s))
	var value wire.ComputerConnectorProcessResult
	if out.Status != "ok" || json.Unmarshal(out.Data, &value) != nil || wire.Validate("ComputerConnectorProcessResult", out.Data) != nil ||
		value.State != "exited" || value.SupervisorState == nil || *value.SupervisorState != "exited" || value.GroupCleanup != "unverified" || value.DescendantCleanup != "unverified" {
		t.Fatal("supervisor result crossed wire as confirmed cleanup", out)
	}
	read, err := s.observeProcess(context.Background(), s.current, "wire-process", processct.ReadRequest{Handle: child.Handle()})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*processct.ReadResponse){
		func(r *processct.ReadResponse) { r.Supervisor = "" },
		func(r *processct.ReadResponse) { r.Supervisor = processct.SupervisorUnknown },
		func(r *processct.ReadResponse) { r.Supervisor = processct.SupervisorRunning },
		func(r *processct.ReadResponse) { r.OutputDrained = false },
		func(r *processct.ReadResponse) { r.State = processct.Terminal },
		func(r *processct.ReadResponse) {
			r.GroupCleanup, r.DescendantCleanup = processct.CleanupConfirmed, processct.CleanupConfirmed
		},
	} {
		bad := *read
		change(&bad)
		if out, err := processReadWire(s.current, processWireRead(s), &bad); out != nil || err == nil {
			t.Fatal("contradictory completion accepted by Go wire", bad)
		}
	}
}

func TestConnectorSupervisedProgressTraversesWire(t *testing.T) {
	s, _, child, _ := processWireFixture(t)
	processWireStarted(t, s)
	child.terminal, child.supervisor = true, processsvc.SupervisorRunning
	response := connectorMutationInvoke(t, s, "computer.process.read", "", processWireRead(s))
	var value wire.ComputerConnectorProcessResult
	if response.Status != "ok" || json.Unmarshal(response.Data, &value) != nil || value.State != "running" || value.RootState != "exited" || value.SupervisorState == nil || *value.SupervisorState != "running" || value.GroupCleanup != "unverified" || value.DescendantCleanup != "unverified" {
		t.Fatalf("known supervisor progress did not cross the actual Go adapter: status=%s code=%s", response.Status, response.Code)
	}
}

func TestConnectorSupervisedProgressWireStillRejectsContradictions(t *testing.T) {
	s, _, child, _ := processWireFixture(t)
	processWireStarted(t, s)
	child.terminal, child.supervisor = true, processsvc.SupervisorRunning
	read, err := s.observeProcess(context.Background(), s.current, "wire-process", processct.ReadRequest{Handle: child.Handle()})
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*processct.ReadResponse){
		func(r *processct.ReadResponse) { r.Supervisor = "" },
		func(r *processct.ReadResponse) { r.Supervisor = processct.SupervisorUnknown },
		func(r *processct.ReadResponse) { r.Supervisor = processct.SupervisorExited },
		func(r *processct.ReadResponse) { r.RootWaited = false },
		func(r *processct.ReadResponse) { r.ExitCode = nil },
		func(r *processct.ReadResponse) { r.ExitSignal = 9 },
		func(r *processct.ReadResponse) { r.GroupCleanup = processct.CleanupPending },
		func(r *processct.ReadResponse) { r.DescendantCleanup = processct.CleanupPending },
		func(r *processct.ReadResponse) {
			r.RootState = processct.RootRunning
			r.RootWaited = false
			r.ExitCode = nil
		},
	} {
		bad := *read
		change(&bad)
		if out, err := processReadWire(s.current, processWireRead(s), &bad); out != nil || err == nil {
			t.Fatal("contradictory supervisor progress accepted", bad)
		}
	}
	for _, drained := range []bool{false, true} {
		progress := *read
		progress.OutputDrained = drained
		out, err := processReadWire(s.current, processWireRead(s), &progress)
		if err != nil || out == nil || out.State != "running" || out.OutputDrained != drained {
			t.Fatal("drain progress did not survive the original supervisor wait", out, err)
		}
	}
}

// Collector settlement uses the positive group witness only; escaped descendants
// remain explicitly unverified. The child and publisher are controlled fixtures.
func TestConnectorSupervisedConfirmedGroupAllowsCurrentDrain(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	child.terminal, child.supervisor, child.groupGone = true, processsvc.SupervisorExited, true
	done := processCollectionDone(s, start.OperationID)
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	if publisher.publishes != 1 || publisher.result == nil || publisher.result.Observation.DescendantCleanup != processsvc.CleanupUnverified ||
		s.drainProcessesForRetirement(context.Background()) != nil || s.mutations.freezeForRetirement() != nil {
		t.Fatal("confirmed group could not drain, or escaped descendants were promoted")
	}
}

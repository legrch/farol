package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
)

// Real registered connector methods and Computer/process owners. The endpoint,
// native producer, physical observation and durable repository are doubles.
// No shell, OS process, socket, native qualification or external caller runs.
type processWireNative struct {
	*connectorProcessNativeDouble
	requests  []connectorShellRequest
	cancels   int
	cancelIO  func()
	cancelErr error
}

func (n *processWireNative) selectShell(ctx context.Context, lease *execution.Lease, request connectorShellRequest) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
	n.requests = append(n.requests, request)
	_, _, err := n.selectLaunch(ctx, lease)
	return n, n, err
}
func (n *processWireNative) Spawn(ctx context.Context, request processsvc.SpawnRequest) (processsvc.Child, error) {
	if _, err := n.connectorProcessNativeDouble.Spawn(ctx, request); err != nil {
		return nil, err
	}
	return n, nil
}
func (n *processWireNative) Cancel(context.Context) (*processsvc.CancelReceipt, error) {
	if !n.unlocked() {
		return nil, errors.New("cancel under owners")
	}
	n.cancels++
	if n.cancelIO != nil {
		n.cancelIO()
	}
	if n.cancelErr != nil {
		return nil, n.cancelErr
	}
	return &processsvc.CancelReceipt{Handle: n.Handle(), Status: processsvc.CancelRequested}, nil
}
func processWireFixture(t *testing.T) (*computerConnector, *connectorProcessJournalDouble, *processWireNative, wire.ComputerConnectorOpen) {
	t.Helper()
	s, _, journal, native, launch := connectorProcessFixture(t)
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	n := &processWireNative{connectorProcessNativeDouble: native}
	s.processes = n.selectShell
	if _, err := s.Open(context.Background(), "wire-open", launch); err != nil {
		t.Fatal(err)
	}
	return s, journal, n, launch
}
func processWireStart(s *computerConnector) wire.ComputerConnectorProcessStart {
	return wire.ComputerConnectorProcessStart{Execution: s.current.opened.Execution, CallId: "start-call", WorkspaceId: "work", RelativeCwd: ".", Command: "synthetic command", Write: false}
}
func processWireStarted(t *testing.T, s *computerConnector) *wire.ComputerConnectorProcessStarted {
	t.Helper()
	out := connectorMutationInvoke(t, s, "computer.process.start", "wire-process", processWireStart(s))
	var value wire.ComputerConnectorProcessStarted
	if out.Status != "ok" || json.Unmarshal(out.Data, &value) != nil || wire.Validate("ComputerConnectorProcessStarted", out.Data) != nil {
		t.Fatal("start refused", out.Status, out.Code)
	}
	return &value
}
func processWireRead(s *computerConnector) wire.ComputerConnectorProcessRead {
	return wire.ComputerConnectorProcessRead{Execution: s.current.opened.Execution, CallId: "read-call", OperationId: "wire-process", Handle: "retained-child", StdoutOffset: "0", StderrOffset: "0"}
}
func processWireCancel(s *computerConnector) wire.ComputerConnectorProcessCancel {
	return wire.ComputerConnectorProcessCancel{Execution: s.current.opened.Execution, CallId: "cancel-call", OperationId: "wire-process", Handle: "retained-child"}
}

func TestConnectorProcessWireNormalStartupDoesNotAdvertiseUnqualifiedShell(t *testing.T) {
	s, _, _, _, launch := connectorProcessFixture(t)
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "normal-open", launch); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"computer.process.start", "computer.process.read", "computer.process.cancel"} {
		if s.current.endpoint.(*connectorEndpointFixture).methods[name].Handle != nil {
			t.Fatal("unqualified method exposed", name)
		}
	}
	if _, err := s.current.route.issuer.Admit(context.Background(), "shell"); err == nil {
		t.Fatal("normal startup admitted Shell")
	}
}

func TestConnectorProcessWireOneStartReadAndReconnect(t *testing.T) {
	s, j, n, launch := processWireFixture(t)
	started := processWireStarted(t, s)
	if started.OperationId != "wire-process" || started.Handle != n.Handle() || j.reserves != 1 || n.spawns != 1 || len(n.requests) != 1 || n.requests[0].Command != "synthetic command" {
		t.Fatal("wrong selected start")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.start", "wire-process", processWireStart(s)); out.Status != "unknown" || n.spawns != 1 || j.reserves != 1 {
		t.Fatal("duplicate dispatched")
	}
	read := processWireRead(s)
	out := connectorMutationInvoke(t, s, "computer.process.read", "", read)
	var result wire.ComputerConnectorProcessResult
	if out.Status != "ok" || json.Unmarshal(out.Data, &result) != nil || result.State != "running" || result.StdoutBase64 != "c2F2ZWQ=" || result.StderrBase64 != "ZXJy" || result.StdoutNext != "5" {
		t.Fatal("read lost exact output", out.Status, out.Code)
	}
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	launch.RuntimeId = "next-runtime"
	launch.ConnectorGeneration = "2"
	if _, err := s.Open(context.Background(), "next-open", launch); err != nil {
		t.Fatal(err)
	}
	n.terminal = true
	out = connectorMutationInvoke(t, s, "computer.process.read", "", processWireRead(s))
	if out.Status != "ok" || json.Unmarshal(out.Data, &result) != nil || result.State != "terminal" || result.ExitCode == nil || *result.ExitCode != 7 || result.Execution == read.Execution || j.reserves != 1 || n.spawns != 1 {
		t.Fatal("reconnect replaced original owner", out.Status, out.Code)
	}
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-reconnected", processWireCancel(s)); out.Status != "refused" || n.cancels != 0 {
		t.Fatal("reconnect restored control")
	}
}

func TestConnectorProcessWireRejectsUntrustedInputBeforeOwner(t *testing.T) {
	for _, kind := range []string{"root", "escape", "write-mismatch", "cwd-mismatch", "workspace", "nul", "command-limit", "stdin-limit", "execution", "unknown-field", "effectless", "id-collision"} {
		t.Run(kind, func(t *testing.T) {
			s, j, n, _ := processWireFixture(t)
			in := processWireStart(s)
			effect := "wire-process"
			var raw any
			switch kind {
			case "root":
				in.RelativeCwd = "/outside"
			case "escape":
				in.RelativeCwd = "../other"
			case "write-mismatch":
				in.Write = true
			case "cwd-mismatch":
				in.RelativeCwd = "other"
			case "workspace":
				in.WorkspaceId = "other"
			case "nul":
				in.Command = "one\x00two"
			case "command-limit":
				in.Command = strings.Repeat("x", 65537)
			case "stdin-limit":
				input := strings.Repeat("x", 262145)
				in.Stdin = &input
			case "execution":
				in.Execution.SessionId = "other"
			case "effectless":
				effect = ""
			case "id-collision":
				effect = "wire-open"
			case "unknown-field":
				b, _ := json.Marshal(in)
				var m map[string]any
				_ = json.Unmarshal(b, &m)
				m["root"] = "/outside"
				raw = m
			}
			if raw == nil {
				raw = in
			}
			if out := connectorMutationInvoke(t, s, "computer.process.start", effect, raw); out.Status == "ok" || j.reserves != 0 || n.spawns != 0 {
				t.Fatal("malformed or crossed input reached execution")
			}
		})
	}
}

func TestConnectorProcessWireEveryCurrentExecutionFieldIsBound(t *testing.T) {
	changes := []func(*wire.ComputerConnectorExecution){func(v *wire.ComputerConnectorExecution) { v.OwnerId = "other" }, func(v *wire.ComputerConnectorExecution) { v.SessionId = "other" }, func(v *wire.ComputerConnectorExecution) { v.TaskId = "other" }, func(v *wire.ComputerConnectorExecution) { v.TaskEpoch = "2" }, func(v *wire.ComputerConnectorExecution) { v.ParticipantId = "other" }, func(v *wire.ComputerConnectorExecution) { v.TurnId = "other" }, func(v *wire.ComputerConnectorExecution) { v.Generation = "2" }}
	for _, change := range changes {
		s, _, n, _ := processWireFixture(t)
		processWireStarted(t, s)
		read := processWireRead(s)
		change(&read.Execution)
		if out := connectorMutationInvoke(t, s, "computer.process.read", "", read); out.Status == "ok" || n.reads != 0 || n.probes != 0 {
			t.Fatal("crossed read reached child")
		}
		cancel := processWireCancel(s)
		change(&cancel.Execution)
		if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-crossed", cancel); out.Status == "ok" || n.cancels != 0 {
			t.Fatal("crossed cancel reached child")
		}
	}
}

func TestConnectorProcessWireCancelRetainsOneAckWithoutSettlement(t *testing.T) {
	s, _, n, _ := processWireFixture(t)
	processWireStarted(t, s)
	for _, id := range []string{"cancel-first", "cancel-observe"} {
		out := connectorMutationInvoke(t, s, "computer.process.cancel", id, processWireCancel(s))
		var result wire.ComputerConnectorProcessCancelled
		if out.Status != "ok" || json.Unmarshal(out.Data, &result) != nil || result.Status != "requested" || result.CancelOperationId != id || result.OperationId != "wire-process" || n.cancels != 1 {
			t.Fatal("cancel ACK repeated effect or lost identities", out.Status, out.Code)
		}
	}
	if s.mutations.operations["wire-process"].settled {
		t.Fatal("cancel ACK settled command")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-first", processWireCancel(s)); out.Status == "ok" || n.cancels != 1 {
		t.Fatal("duplicate cancel operation reused")
	}
}

func TestConnectorProcessWireCancellationFailurePermanentlyFencesOwner(t *testing.T) {
	s, _, n, _ := processWireFixture(t)
	processWireStarted(t, s)
	n.cancelErr = errors.New("lost cancellation ACK")
	n.cancelIO = func() {
		if s.mutations.operations["wire-process"].settled {
			t.Fatal("retirement may pass during cancel")
		}
	}
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-first", processWireCancel(s)); out.Status != "unknown" || n.cancels != 1 {
		t.Fatal("lost cancel upgraded")
	}
	n.cancelErr = nil
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-new", processWireCancel(s)); out.Status != "unknown" || n.cancels != 1 {
		t.Fatal("unknown cancel retried")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.read", "", processWireRead(s)); out.Status != "unknown" || n.reads != 0 {
		t.Fatal("live bytes cleared control uncertainty")
	}
	if _, err := s.retainProcess(context.Background(), s.current, "wire-process"); err == nil {
		t.Fatal("terminal retention cleared control uncertainty")
	}
}

func TestConnectorProcessWireWrongCancelHandleDoesNotPoisonOriginal(t *testing.T) {
	s, _, n, _ := processWireFixture(t)
	processWireStarted(t, s)
	wrong := processWireCancel(s)
	wrong.Handle = "other"
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-wrong", wrong); out.Status != "refused" || n.cancels != 0 {
		t.Fatal("wrong handle dispatched")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.read", "", processWireRead(s)); out.Status != "ok" {
		t.Fatal("known refusal poisoned original")
	}
}

func TestConnectorProcessWireLateCancelWithdrawalCannotDiscloseAck(t *testing.T) {
	s, _, n, _ := processWireFixture(t)
	processWireStarted(t, s)
	n.cancelIO = func() { s.current.guard.close() }
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-late", processWireCancel(s)); out.Status != "unknown" || n.cancels != 1 {
		t.Fatal("late stale cancellation ACK disclosed", out.Status, out.Code)
	}
	p := s.mutations.operations["wire-process"]
	if p.settled || !p.process.cancelUnknown {
		t.Fatal("lost current cancellation settled")
	}
}

func TestConnectorProcessWireRepeatedHostMetadataCannotRestoreControl(t *testing.T) {
	s, _, n, launch := processWireFixture(t)
	processWireStarted(t, s)
	original := s.current
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "same-metadata-reopen", launch); err != nil {
		t.Fatal(err)
	}
	if s.current == original || s.current.guard.host != original.guard.host || s.current.opened.Execution == original.opened.Execution {
		t.Fatal("fixture did not replace the connector with identical host metadata")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-new-owner", processWireCancel(s)); out.Status != "refused" || n.cancels != 0 {
		t.Fatal("replacement connector restored original process control", out.Status, out.Code, n.cancels)
	}
	if out := connectorMutationInvoke(t, s, "computer.process.read", "", processWireRead(s)); out.Status != "ok" || n.reads != 1 {
		t.Fatal("current observation was incorrectly removed", out.Status, out.Code)
	}
}

func TestConnectorProcessWireRejectsCrossedReadData(t *testing.T) {
	for _, change := range []func(*processct.ReadResponse){
		func(v *processct.ReadResponse) { v.Handle = "other" }, func(v *processct.ReadResponse) { v.StdoutNext++ }, func(v *processct.ReadResponse) { v.StdoutBase64 = "!!!!" }, func(v *processct.ReadResponse) { v.StdoutBase64 = "c2F2ZWQ=\n" }, func(v *processct.ReadResponse) { v.StdoutBytes = processsvc.MaximumOutput }, func(v *processct.ReadResponse) { v.State = processct.Terminal }, func(v *processct.ReadResponse) { v.ExitSignal = 1 },
	} {
		s, _, n, _ := processWireFixture(t)
		processWireStarted(t, s)
		in := processWireRead(s)
		out, err := s.observeProcess(context.Background(), s.current, in.OperationId, processct.ReadRequest{Handle: n.Handle()})
		if err != nil {
			t.Fatal(err)
		}
		change(out)
		if result, err := processReadWire(s.current, in, out); err == nil || result != nil {
			t.Fatal("crossed result serialized")
		}
	}
}

func TestConnectorProcessWireReadOffsetsAndEffectKind(t *testing.T) {
	for _, offset := range []string{"01", "-1", "4194305", "18446744073709551616"} {
		s, _, n, _ := processWireFixture(t)
		processWireStarted(t, s)
		in := processWireRead(s)
		in.StdoutOffset = offset
		if out := connectorMutationInvoke(t, s, "computer.process.read", "", in); out.Status == "ok" || n.reads != 0 || n.probes != 0 {
			t.Fatal("invalid offset reached child")
		}
	}
	s, _, n, _ := processWireFixture(t)
	processWireStarted(t, s)
	if out := connectorMutationInvoke(t, s, "computer.process.read", "effect", processWireRead(s)); out.Status == "ok" || n.reads != 0 {
		t.Fatal("read accepted effect identity")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "", processWireCancel(s)); out.Status == "ok" || n.cancels != 0 {
		t.Fatal("cancel missing effect identity")
	}
}

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
	"github.com/legrch/farol/modules/computer/domain/authority"
	nativeprocess "github.com/legrch/farol/modules/computer/infra/process"
)

// Real registered connector methods and Computer/process owners. The endpoint,
// native producer, physical observation and durable repository are doubles.
// No shell, OS process, socket, native qualification or external caller runs.
type processWireNative struct {
	*connectorProcessNativeDouble
	requests     []connectorShellRequest
	cancels      int
	cancelIO     func()
	cancelErr    error
	cancelStatus processsvc.CancelStatus
	selection    connectorShellSelection
}

func (n *processWireNative) selectShell(ctx context.Context, lease *execution.Lease, request connectorShellRequest) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
	n.requests = append(n.requests, request)
	if n.selection != nil {
		return n.selection(ctx, lease, request)
	}
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
	status := n.cancelStatus
	if status == "" {
		status = processsvc.CancelRequested
	}
	return &processsvc.CancelReceipt{Handle: n.Handle(), Status: status}, nil
}
func processWireFixture(t *testing.T) (*computerConnector, *connectorProcessJournalDouble, *processWireNative, wire.ComputerConnectorOpen) {
	t.Helper()
	return processWireFixtureWithPolicy(t, authority.FilePolicy(""))
}
func processWireFixtureWithPolicy(t *testing.T, policy authority.FilePolicy) (*computerConnector, *connectorProcessJournalDouble, *processWireNative, wire.ComputerConnectorOpen) {
	t.Helper()
	s, access, journal, native, launch := connectorProcessFixture(t)
	access.approval.FilePolicy = policy
	access.PutApproval(access.approval)
	s.root.publication.approval = access.approval.Clone()
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

func TestConnectorProcessWireRetainsOnlyPreFilteredAuditCommand(t *testing.T) {
	for _, test := range []struct {
		name        string
		filter      processsvc.AuditScalarFilter
		state, text string
	}{
		{"unavailable", nil, "unavailable", ""},
		{"filtered", func(s string) (string, error) { return s, nil }, "filtered", "[REDACTED]"},
		{"failure", func(string) (string, error) { panic("PRIVATE-PANIC") }, "unavailable", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, native, _ := processWireFixture(t)
			s.auditFilter = test.filter
			request := processWireStart(s)
			request.Command = "git --password=PRIVATE-COMMAND"
			request.Stdin = new(string)
			*request.Stdin = "PRIVATE-STDIN"
			out := connectorMutationInvoke(t, s, "computer.process.start", "wire-process", request)
			if out.Status != "ok" || native.spawns != 1 {
				t.Fatal("audit affected process start")
			}
			s.mutations.mu.Lock()
			command := s.mutations.operations["wire-process"].process.auditCommand
			s.mutations.mu.Unlock()
			details := processsvc.ProjectAuditWithCommand(processsvc.AuditInput{}, command, test.filter)
			encoded, err := json.Marshal(details)
			if err != nil || details.Command.State != test.state || details.Command.Text != test.text || strings.Contains(string(encoded), "PRIVATE-") {
				t.Fatal("unfiltered input escaped into audit data")
			}
		})
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

func TestConnectorProcessWirePreservesPreparationAcrossAllWrappers(t *testing.T) {
	for _, tc := range connectorPreparationCases() {
		t.Run(tc.name, func(t *testing.T) {
			s, journal, native, _ := processWireFixtureWithPolicy(t, authority.RootScopedFiles)
			f := newShellFactoryFixture(t)
			f.factory.clock, f.factory.lifetime = s.clock, s.lifetime
			f.factory.scratch = func(context.Context) (connectorShellScratch, error) {
				return connectorShellScratch{path: "/private/tmp/farol-shell-cpu", identity: authority.RootIdentity{Device: "1", Inode: "9"}}, nil
			}
			preparations := 0
			f.factory.prepare = func(context.Context, nativeprocess.Command, nativeprocess.SeatbeltSelection, processsvc.Invocation) (processsvc.Selected, error) {
				preparations++
				return nil, tc.err
			}
			native.selection = f.factory.selectShell
			out := connectorMutationInvoke(t, s, "computer.process.start", "preparation-operation", processWireStart(s))
			status := "refused"
			if tc.outcome == "outcome_unknown" {
				status = "unknown"
			}
			if out.Status != status || out.Code != tc.code || len(out.Data) != 0 || preparations != 1 || journal.reserves != 0 || native.spawns != 0 {
				t.Fatal("wire preparation classification was lost or leaked", out.Status, out.Code, preparations)
			}
			if out := connectorMutationInvoke(t, s, "computer.process.start", "preparation-operation", processWireStart(s)); out.Status != "unknown" || preparations != 1 {
				t.Fatal("preparation outcome permitted replay")
			}
		})
	}
}

func TestConnectorCancelAfterPublishedExitDoesNotSignalOrInventUnknown(t *testing.T) {
	for _, mode := range []string{"known", "wrong-handle", "unknown-cancel", "lost-publication"} {
		t.Run(mode, func(t *testing.T) {
			s, journal, n, _ := processWireFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
			s.mutations.dependencies.repository = publisher
			started := processWireStarted(t, s)
			n.terminal = true
			if _, err := s.retainProcess(context.Background(), s.current, started.OperationId); err != nil {
				t.Fatal(err)
			}
			p := s.mutations.operations[started.OperationId].process
			before := p.publication
			request := processWireCancel(s)
			code, status := "PROCESS_ALREADY_EXITED", "refused"
			switch mode {
			case "wrong-handle":
				request.Handle = "other-handle"
				code = "PROCESS_HANDLE_MISMATCH"
			case "unknown-cancel":
				p.cancelUnknown = true
				code = "PROCESS_OUTCOME_UNKNOWN"
				status = "unknown"
			case "lost-publication":
				p.publication = ""
				code = "PROCESS_OUTCOME_UNKNOWN"
				status = "unknown"
			}
			out := connectorMutationInvoke(t, s, "computer.process.cancel", "late-cancel", request)
			if out.Status != status || out.Code != code || n.cancels != 0 || p.cancelling {
				t.Fatalf("unexpected control: %+v signals=%d", out, n.cancels)
			}
			if mode == "known" && (p.cancelUnknown || p.publication != before || !s.mutations.operations[started.OperationId].settled) {
				t.Fatal("known exit changed original settlement")
			}
			if mode == "unknown-cancel" && !p.cancelUnknown {
				t.Fatal("old unknown cleared")
			}
		})
	}
}

// Real Go owner/collector/wire, controlled native child and journal. This checks
// publication ordering, not actual POSIX group cleanup or Electron reopening.
func TestConnectorNoOpCancelBeforeExitPublicationDrainsWithoutRewritingResult(t *testing.T) {
	s, journal, child, _ := processWireFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	processWireStarted(t, s)
	child.terminal, child.cancelStatus = true, processsvc.AlreadyTerminal
	out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-after-reap", processWireCancel(s))
	var cancelled wire.ComputerConnectorProcessCancelled
	if out.Status != "ok" || json.Unmarshal(out.Data, &cancelled) != nil || cancelled.Status != "already_terminal" || child.cancels != 1 {
		t.Fatal("no-op Cancel poisoned the reaped process", out)
	}
	s.mutations.mu.Lock()
	record := s.mutations.operations["wire-process"]
	premature := record.settled || publisher.publishes != 0 || record.process.cancelUnknown
	s.mutations.mu.Unlock()
	if premature {
		t.Fatal("Cancel ACK published or settled an unobserved exit")
	}
	done := processCollectionDone(s, "wire-process")
	close(child.completed)
	awaitProcessCollectionDone(t, done)
	if publisher.publishes != 1 || publisher.result == nil || publisher.result.Observation.GroupCleanup != processsvc.CleanupConfirmed || s.drainProcessesForRetirement(context.Background()) != nil {
		t.Fatal("original exit and cleanup did not close the operation exactly once")
	}
	if out := connectorMutationInvoke(t, s, "computer.process.cancel", "cancel-after-publication", processWireCancel(s)); out.Status != "refused" || child.cancels != 1 || publisher.publishes != 1 {
		t.Fatal("late Cancel overwrote or repeated the published result", out)
	}
}

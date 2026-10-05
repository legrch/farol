package boot

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/transport/desktop"
)

// Actual registered wire handlers and Go owners; the endpoint, filesystem and
// journal are injected. This is not native/socket/normal-app acceptance.
func connectorMutationInvoke(t *testing.T, s *computerConnector, method, operation string, in any) *desktop.Outcome {
	t.Helper()
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	handler := s.current.endpoint.(*connectorEndpointFixture).methods[method]
	if handler.Handle == nil {
		t.Fatal("missing registered mutation route", method)
	}
	out, err := handler.Handle(context.Background(), desktop.Request{RequestID: "request", OperationID: operation, Body: body})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func connectorWireWrite(s *computerConnector) wire.ComputerConnectorWrite {
	return wire.ComputerConnectorWrite{Execution: s.current.opened.Execution, CallId: "write-call", WorkspaceId: "work", RelativePath: "note.md", Content: "new"}
}

func connectorWireResult(t *testing.T, out *desktop.Outcome) wire.ComputerConnectorMutationResponse {
	t.Helper()
	var result wire.ComputerConnectorMutationResponse
	if out == nil || out.Status != "ok" || wire.Validate("ComputerConnectorMutationResponse", out.Data) != nil || json.Unmarshal(out.Data, &result) != nil {
		t.Fatal("invalid mutation reply", out)
	}
	return result
}

func TestConnectorMutationWireRoundTripAndReadAfterReconnect(t *testing.T) {
	s, _, journal, native, launch := connectorMutationFixture(t)
	in := connectorWireWrite(s)
	first := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.write", "write-operation", in))
	if first.Origin.Binding != s.current.opened.Endpoint.Binding || first.Origin.Execution != in.Execution || first.Origin.CallId != in.CallId || first.Receipt == nil || first.Receipt.Operation != "write" || first.Origin.Binding.ConnectorGeneration != "9007199254740993" {
		t.Fatal("crossed original write")
	}
	edit := wire.ComputerConnectorEdit{Execution: in.Execution, CallId: "edit-call", WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath, ExpectedSHA256: first.Receipt.AfterSHA256, Edits: []wire.ComputerTextEdit{{OldText: "new", NewText: "edited"}}}
	second := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.edit", "edit-operation", edit))
	if second.Receipt == nil || second.Receipt.BeforeSHA256 == nil || *second.Receipt.BeforeSHA256 != first.Receipt.AfterSHA256 || second.Origin.Operation != "edit" || second.Receipt.Replacements != 1 {
		t.Fatal("edit preimage lost")
	}
	if out := connectorMutationInvoke(t, s, "computer.workspace.write", "write-operation", in); out.Status != "unknown" || native.calls != 2 || journal.admits != 2 {
		t.Fatal("duplicate executed or became retryable")
	}
	reconnectMutationFixture(t, s, launch)
	read := wire.ComputerConnectorMutationRead{Execution: s.current.opened.Execution, CallId: "read-current", OperationId: "write-operation", WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath}
	result := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.mutation.read", "", read))
	if result.Execution != read.Execution || result.CallId != read.CallId || result.Origin != first.Origin || result.Execution == result.Origin.Execution || result.Receipt.AfterSHA256 != first.Receipt.AfterSHA256 || native.calls != 2 || journal.admits != 2 || journal.loads != 0 {
		t.Fatal("retained observation rewrote original or executed again")
	}
}

func TestConnectorMutationWireRejectsEveryCrossedExecution(t *testing.T) {
	changes := []func(*wire.ComputerConnectorExecution){
		func(v *wire.ComputerConnectorExecution) { v.OwnerId = "other" }, func(v *wire.ComputerConnectorExecution) { v.SessionId = "other" },
		func(v *wire.ComputerConnectorExecution) { v.TaskId = "other" }, func(v *wire.ComputerConnectorExecution) { v.TaskEpoch = "2" },
		func(v *wire.ComputerConnectorExecution) { v.ParticipantId = "other" }, func(v *wire.ComputerConnectorExecution) { v.TurnId = "other" },
		func(v *wire.ComputerConnectorExecution) { v.Generation = "2" },
	}
	for _, change := range changes {
		s, _, journal, native, _ := connectorMutationFixture(t)
		in := connectorWireWrite(s)
		change(&in.Execution)
		if out := connectorMutationInvoke(t, s, "computer.workspace.write", "operation", in); out.Status == "ok" || native.calls != 0 || journal.admits != 0 || len(s.mutations.operations) != 0 {
			t.Fatal("request selected different execution")
		}
		read := wire.ComputerConnectorMutationRead{Execution: in.Execution, CallId: "observe", OperationId: "operation", WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath}
		if out := connectorMutationInvoke(t, s, "computer.workspace.mutation.read", "", read); out.Status == "ok" || journal.loads != 0 {
			t.Fatal("foreign observation read journal")
		}
	}
}

func TestConnectorMutationWireRejectsMalformedBeforeOwner(t *testing.T) {
	for _, variant := range []string{"no-operation", "extra-authority", "duplicate", "invalid-unicode", "utf8-bytes", "escaped-body", "empty-edits", "excess-edits", "read-effect"} {
		t.Run(variant, func(t *testing.T) {
			s, _, journal, native, _ := connectorMutationFixture(t)
			in := connectorWireWrite(s)
			method, operation := "computer.workspace.write", "operation"
			var input any = in
			switch variant {
			case "no-operation":
				operation = ""
			case "utf8-bytes":
				in.Content = strings.Repeat("界", 87382)
				input = in
			case "escaped-body":
				in.Content = strings.Repeat("\x01", 90000)
				input = in
			case "empty-edits", "excess-edits":
				method = "computer.workspace.edit"
				edits := []wire.ComputerTextEdit{}
				if variant == "excess-edits" {
					for i := 0; i < 257; i++ {
						edits = append(edits, wire.ComputerTextEdit{OldText: "x", NewText: "y"})
					}
				}
				input = wire.ComputerConnectorEdit{Execution: in.Execution, CallId: in.CallId, WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath, ExpectedSHA256: strings.Repeat("a", 64), Edits: edits}
			case "read-effect":
				method = "computer.workspace.mutation.read"
				input = wire.ComputerConnectorMutationRead{Execution: in.Execution, CallId: in.CallId, WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath, OperationId: "original"}
			}
			raw, _ := json.Marshal(input)
			switch variant {
			case "extra-authority":
				raw = append([]byte(`{"ownerId":"foreign",`), raw[1:]...)
			case "duplicate":
				raw = append([]byte(`{"workspaceId":"work",`), raw[1:]...)
			case "invalid-unicode":
				raw = []byte(strings.Replace(string(raw), `"new"`, `"\ud800"`, 1))
			}
			out, err := s.current.endpoint.(*connectorEndpointFixture).methods[method].Handle(context.Background(), desktop.Request{OperationID: operation, Body: raw})
			if err != nil || out == nil || out.Status == "ok" || journal.admits != 0 || journal.loads != 0 || native.calls != 0 || len(s.mutations.operations) != 0 {
				t.Fatal("invalid request reached owner", out, err)
			}
		})
	}
}

func TestConnectorMutationWireRequiresSelectedOwnerAndCurrentWrite(t *testing.T) {
	s, _, _, endpoint, launch := newConnectorFixture(t)
	if _, err := s.Open(context.Background(), "open", launch); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"computer.workspace.write", "computer.workspace.edit", "computer.workspace.mutation.read"} {
		if endpoint.methods[name].Handle != nil {
			t.Fatal("unowned mutation route exposed")
		}
	}
	s, access, journal, native, _ := connectorMutationFixture(t)
	access.approval.Capabilities = []authority.Capability{authority.List, authority.Read}
	access.approval.Workspaces[0].Access = authority.ReadAccess
	access.PutApproval(access.approval)
	if out := connectorMutationInvoke(t, s, "computer.workspace.write", "denied", connectorWireWrite(s)); out.Status == "ok" || native.calls != 0 || journal.admits != 0 {
		t.Fatal("read approval became write authority")
	}
}

func TestConnectorMutationWireKeepsLostPublicationAndClosedSlot(t *testing.T) {
	s, _, journal, native, launch := connectorMutationFixture(t)
	journal.saveFault = "after"
	in := connectorWireWrite(s)
	first := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.write", "operation", in))
	if first.Publication != "memory_only" || first.Phase != "completed" {
		t.Fatal("lost publication promoted")
	}
	old := s.current.endpoint.(*connectorEndpointFixture).methods["computer.workspace.write"]
	reconnectMutationFixture(t, s, launch)
	read := wire.ComputerConnectorMutationRead{Execution: s.current.opened.Execution, CallId: "read", OperationId: "operation", WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath}
	result := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.mutation.read", "", read))
	if result.Publication != "memory_only" || result.Origin != first.Origin || journal.loads != 0 || native.calls != 1 || s.mutations.freezeForRetirement() == nil {
		t.Fatal("lost ACK upgraded on reconnect")
	}
	data, _ := json.Marshal(in)
	out, err := old.Handle(context.Background(), desktop.Request{OperationID: "stale-slot", Body: data})
	if err != nil || out == nil || out.Status == "ok" || native.calls != 1 || journal.admits != 1 {
		t.Fatal("closed slot admitted effect")
	}
}

func TestConnectorMutationWireRejectsCrossedResult(t *testing.T) {
	s, _, _, _, _ := connectorMutationFixture(t)
	in := connectorWriteFixture()
	original, err := s.mutate(context.Background(), s.current, "operation", "call", in)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*mutationct.ConnectorResponse){
		func(v *mutationct.ConnectorResponse) { v.OperationID = "crossed" },
		func(v *mutationct.ConnectorResponse) { v.Origin.CallID = "crossed" },
		func(v *mutationct.ConnectorResponse) { v.Origin.ConnectorGeneration++ },
		func(v *mutationct.ConnectorResponse) { v.ComputerGeneration++ },
		func(v *mutationct.ConnectorResponse) { v.Phase = "failed" },
		func(v *mutationct.ConnectorResponse) { v.Receipt.Bytes = 8*1024*1024 + 1 },
		func(v *mutationct.ConnectorResponse) { v.Receipt.Replacements = 1 },
		func(v *mutationct.ConnectorResponse) { hash := strings.Repeat("b", 64); v.Receipt.BeforeSHA256 = &hash },
	} {
		copy := *original
		receipt := *original.Receipt
		copy.Receipt = &receipt
		change(&copy)
		if out, err := connectorMutationWireResult(s.current, "call", "operation", in.WorkspaceID, "note.md", in.Operation, &copy); err == nil || out != nil {
			t.Fatal("crossed result accepted")
		}
	}
}

func TestConnectorMutationWireLateDisclosureIsUnknown(t *testing.T) {
	s, access, journal, native, launch := connectorMutationFixture(t)
	native.after = func() { access.clock.now = access.clock.now.Add(16 * time.Second) }
	in := connectorWireWrite(s)
	out := connectorMutationInvoke(t, s, "computer.workspace.write", "operation", in)
	if out.Status != "unknown" || journal.saves != 1 || native.calls != 1 || s.mutations.operations["operation"].settled {
		t.Fatalf("possible effect misclassified: status=%s code=%s saves=%d native=%d", out.Status, out.Code, journal.saves, native.calls)
	}
	reconnectMutationFixture(t, s, launch)
	read := wire.ComputerConnectorMutationRead{Execution: s.current.opened.Execution, CallId: "observe", OperationId: "operation", WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath}
	result := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.mutation.read", "", read))
	if result.Phase != "completed" || result.Publication != "durable" || result.Origin.CallId != in.CallId || native.calls != 1 || journal.loads != 0 {
		t.Fatal("unknown delivery lost original completed result")
	}
}

func TestConnectorMutationWireEditArrayBoundary(t *testing.T) {
	for _, count := range []int{128, 129, 256, 257} {
		s, _, _, native, _ := connectorMutationFixture(t)
		in := connectorWireWrite(s)
		edits := make([]wire.ComputerTextEdit, count)
		for i := range edits {
			edits[i] = wire.ComputerTextEdit{OldText: "old-" + decimal(uint64(i)), NewText: "new-" + decimal(uint64(i))}
		}
		edit := wire.ComputerConnectorEdit{Execution: in.Execution, CallId: in.CallId, WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath, ExpectedSHA256: strings.Repeat("a", 64), Edits: edits}
		out := connectorMutationInvoke(t, s, "computer.workspace.edit", "operation", edit)
		if count <= 256 {
			if out.Status != "ok" || native.calls != 1 {
				t.Fatalf("valid %d-edit request refused: %s/%s", count, out.Status, out.Code)
			}
		} else if out.Status == "ok" || native.calls != 0 {
			t.Fatal("257 edits admitted")
		}
	}
}

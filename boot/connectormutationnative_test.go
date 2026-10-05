//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// Real normal Go composition, private Darwin socket, journal and filesystem.
// Workspace approval and the inherited-host open call are explicit fixtures.
// This test launches no app/child/provider and does not qualify Electron/MCP or
// host retirement. Only its own disposable roots are used.
type nativeMutationPeer struct {
	stream net.Conn
	opened wire.ComputerConnectorOpened
	next   int
}

func openNativeMutationPeer(t *testing.T, runtime *NativeRuntime, publication wire.ComputerAuthorityPublication, suffix string) *nativeMutationPeer {
	t.Helper()
	out := nativeSettingsCall(t, runtime, "computer.connector.open", "open-"+suffix, wire.ComputerConnectorOpen{Publication: publication, RuntimeId: "runtime-" + suffix, ConnectorGeneration: suffix, LaunchDigest: strings.Repeat("b", 64)})
	var opened wire.ComputerConnectorOpened
	if out.Status != "ok" || json.Unmarshal(out.Data, &opened) != nil {
		t.Fatal("native connector open failed", out.Status, out.Code)
	}
	root := filepath.Dir(opened.Endpoint.SocketPath)
	rootInfo, err := os.Lstat(root)
	if err != nil {
		t.Fatal(err)
	}
	socketInfo, err := os.Lstat(opened.Endpoint.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(root) != "/private/tmp" || !strings.HasPrefix(filepath.Base(root), "farol-mcp-") {
		t.Fatal("unexpected owned socket root")
	}
	t.Cleanup(func() {
		// Close the exact selected owner before test-owned unlink. Changed or
		// failed roots remain evidence; no glob or stale cleanup is performed.
		if runtime.connector.current != nil && runtime.connector.current.opened.Endpoint == opened.Endpoint {
			if _, err := runtime.connector.Close(context.Background(), "close-"+suffix, wire.ComputerConnectorClose{Binding: opened.Endpoint.Binding}); err != nil {
				t.Error(err)
				return
			}
		}
		if t.Failed() {
			return
		}
		a, e1 := os.Lstat(root)
		b, e2 := os.Lstat(opened.Endpoint.SocketPath)
		if e1 != nil || e2 != nil || !os.SameFile(a, rootInfo) || !os.SameFile(b, socketInfo) {
			t.Error("native socket cleanup identity changed")
			return
		}
		if err := os.Remove(opened.Endpoint.SocketPath); err != nil {
			t.Error(err)
			return
		}
		if err := os.Remove(root); err != nil {
			t.Error(err)
		}
	})
	stream, err := net.DialTimeout("unix", opened.Endpoint.SocketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stream.Close() })
	if err := stream.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}
	writeNativeMutationJSON(t, stream, wire.ComputerConnectorHello{Binding: opened.Endpoint.Binding, Token: opened.Endpoint.Token})
	raw, err := ipc.ReadFrame(stream)
	var ack wire.ComputerConnectorBinding
	if err != nil || json.Unmarshal(raw, &ack) != nil || ack != opened.Endpoint.Binding {
		t.Fatal("native socket auth failed")
	}
	hello, _ := json.Marshal(wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: opened.Endpoint.Binding.BuildId, ProfileId: opened.Endpoint.Binding.ProfileId})
	writeNativeMutationJSON(t, stream, wire.Request{Jsonrpc: "2.0", Id: "hello", Method: "core.handshake", Params: wire.Call{Body: hello}})
	raw, err = ipc.ReadFrame(stream)
	var response wire.Response
	var identity wire.Identity
	if err != nil || wire.Validate("Response", raw) != nil || json.Unmarshal(raw, &response) != nil || response.Result == nil || response.Result.Status != "ok" || json.Unmarshal(response.Result.Data, &identity) != nil {
		t.Fatal("native handshake failed")
	}
	for _, name := range []string{"computer.workspace.write", "computer.workspace.edit", "computer.workspace.mutation.read"} {
		if !slices.Contains(identity.Capabilities, name) {
			t.Fatal("normal Go runtime omitted mutation route", name)
		}
	}
	return &nativeMutationPeer{stream: stream, opened: opened}
}

func writeNativeMutationJSON(t *testing.T, stream net.Conn, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := ipc.WriteFrame(stream, raw); err != nil {
		t.Fatal(err)
	}
}

func (p *nativeMutationPeer) call(t *testing.T, method, operation string, body any) *wire.Outcome {
	t.Helper()
	p.next++
	id := decimal(uint64(p.next))
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	bound := wire.Context{ProfileId: p.opened.Endpoint.Binding.ProfileId, BackendGeneration: p.opened.Endpoint.Binding.BackendGeneration}
	params := wire.Call{Context: &bound, Body: raw}
	if operation != "" {
		params.OperationId = &operation
	}
	writeNativeMutationJSON(t, p.stream, wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: params})
	raw, err = ipc.ReadFrame(p.stream)
	var reply wire.Response
	if err != nil || wire.Validate("Response", raw) != nil || json.Unmarshal(raw, &reply) != nil || reply.Result == nil || reply.Result.RequestId != id || reply.Result.Context != bound || (reply.Result.OperationId == nil) != (operation == "") || operation != "" && *reply.Result.OperationId != operation {
		t.Fatal("native reply lost correlation", err)
	}
	return reply.Result
}

func nativeMutationResult(t *testing.T, out *wire.Outcome, phase string) wire.ComputerConnectorMutationResponse {
	t.Helper()
	var result wire.ComputerConnectorMutationResponse
	if out.Status != "ok" || wire.Validate("ComputerConnectorMutationResponse", out.Data) != nil || json.Unmarshal(out.Data, &result) != nil || result.Phase != phase || result.Publication != "durable" {
		t.Fatal("native mutation did not retain expected phase", out.Status, out.Code)
	}
	return result
}

func TestNativeConnectorMutationNormalRuntimeSocketAndReconnect(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	peer := openNativeMutationPeer(t, runtime, publication, "9007199254740993")
	const workspaceID = "00000000-0000-4000-8000-000000000004"
	write := wire.ComputerConnectorWrite{Execution: peer.opened.Execution, CallId: "create", WorkspaceId: workspaceID, RelativePath: "note.md", Content: "one old fragment\n"}
	first := nativeMutationResult(t, peer.call(t, "computer.workspace.write", "native-create", write), "completed")
	if first.Origin.Binding != peer.opened.Endpoint.Binding || first.Receipt.BeforeSHA256 != nil {
		t.Fatal("native create correlation changed")
	}
	nativeMutationResult(t, peer.call(t, "computer.workspace.write", "native-collision", write), "failed")
	edit := wire.ComputerConnectorEdit{Execution: peer.opened.Execution, CallId: "edit", WorkspaceId: workspaceID, RelativePath: write.RelativePath, ExpectedSHA256: strings.Repeat("0", 64), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}}
	conflict := nativeMutationResult(t, peer.call(t, "computer.workspace.edit", "native-conflict", edit), "failed")
	if conflict.Failure == nil || conflict.Failure.Code != "WORKSPACE_MUTATION_CONFLICT" {
		t.Fatal("stale preimage not refused")
	}
	edit.ExpectedSHA256 = first.Receipt.AfterSHA256
	second := nativeMutationResult(t, peer.call(t, "computer.workspace.edit", "native-edit", edit), "completed")
	target := filepath.Join(workspace, write.RelativePath)
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "one new fragment\n" || second.Receipt.BeforeSHA256 == nil || *second.Receipt.BeforeSHA256 != first.Receipt.AfterSHA256 {
		t.Fatal("native edit did not publish exact bytes", err)
	}
	if err := peer.stream.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.connector.Close(context.Background(), "first-close", wire.ComputerConnectorClose{Binding: peer.opened.Endpoint.Binding}); err != nil {
		t.Fatal(err)
	}
	next := openNativeMutationPeer(t, runtime, publication, "9007199254740994")
	read := wire.ComputerConnectorMutationRead{Execution: next.opened.Execution, CallId: "observe", WorkspaceId: workspaceID, RelativePath: write.RelativePath, OperationId: "native-edit"}
	retained := nativeMutationResult(t, next.call(t, "computer.workspace.mutation.read", "", read), "completed")
	if retained.Origin != second.Origin || retained.Execution != read.Execution || retained.Origin.Execution == retained.Execution || retained.Receipt.AfterSHA256 != second.Receipt.AfterSHA256 {
		t.Fatal("reconnect lost original receipt")
	}
	write.Execution, write.CallId = next.opened.Execution, "duplicate"
	if out := next.call(t, "computer.workspace.write", "native-create", write); out.Status != "unknown" {
		t.Fatal("duplicate was replayed or upgraded")
	}
	if _, err := runtime.ingress.Deactivate(context.Background(), "withdraw"); err != nil {
		t.Fatal(err)
	}
	if out := next.call(t, "computer.workspace.write", "withdrawn", write); out.Status == "ok" {
		t.Fatal("withdrawn write accepted")
	}
	if out := next.call(t, "computer.workspace.mutation.read", "", read); out.Status == "ok" {
		t.Fatal("withdrawn observation disclosed")
	}
	content, err = os.ReadFile(target)
	if err != nil || string(content) != "one new fragment\n" {
		t.Fatal("duplicate or withdrawn effect changed bytes", err)
	}
	if len(runtime.mutations.operations) != 5 {
		t.Fatal("connector did not use the same bounded mutation ledger")
	}
}

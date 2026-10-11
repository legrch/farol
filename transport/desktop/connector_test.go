package desktop

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

// In-memory pipes qualify framing/authentication only, not filesystem modes,
// OS peer credentials, native sockets, module authority or app/MCP composition.
func connectorFixture(t *testing.T, readMethods ...string) (net.Conn, ConnectorConfig, *atomic.Int32, <-chan error) {
	t.Helper()
	client, server := net.Pipe()
	binding := wire.ComputerConnectorBinding{BuildId: "build", ProfileId: "profile", BackendGeneration: "backend", RuntimeId: "connector-runtime", ConnectorGeneration: "9007199254740993"}
	calls := &atomic.Int32{}
	config := ConnectorConfig{Endpoint: wire.ComputerConnectorEndpoint{Binding: binding, SocketPath: "/private/tmp/fixture.sock", Token: strings.Repeat("a", 64)}, Methods: map[string]Method{"computer.workspace.list": {Handle: func(context.Context, Request) (*Outcome, error) {
		calls.Add(1)
		return &Outcome{Status: "ok", Data: json.RawMessage(`{}`)}, nil
	}}}}
	for _, name := range readMethods {
		config.Methods[name] = config.Methods["computer.workspace.list"]
	}
	done := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { done <- serveConnectorConnection(ctx, server, config) }()
	t.Cleanup(func() { cancel(); _ = client.Close() })
	if err := client.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	return client, config, calls, done
}

func TestConnectionVerificationObservationHandshakeAndReadOnlyDispatch(t *testing.T) {
	testConnectionVerificationReadOnly(t, "computer.connector.verification")
}
func TestConnectionCatalogueVerificationHandshakeAndReadOnlyDispatch(t *testing.T) {
	testConnectionVerificationReadOnly(t, "computer.connector.catalogueverify")
}
func testConnectionVerificationReadOnly(t *testing.T, method string) {
	t.Helper()
	client, config, calls, done := connectorFixture(t, method)
	writeConnectorJSON(t, client, wire.ComputerConnectorHello{Binding: config.Endpoint.Binding, Token: config.Endpoint.Token})
	var authenticated wire.ComputerConnectorBinding
	readConnectorJSON(t, client, &authenticated)
	writeConnectorJSON(t, client, map[string]any{"jsonrpc": "2.0", "id": "hello", "method": "core.handshake", "params": map[string]any{"body": wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: "build", ProfileId: "profile"}}})
	var reply wire.Response
	readConnectorJSON(t, client, &reply)
	if reply.Result == nil || reply.Result.Status != "ok" {
		t.Fatal("observation config failed handshake")
	}
	var identity wire.Identity
	if json.Unmarshal(reply.Result.Data, &identity) != nil || !slices.Contains(identity.Capabilities, method) {
		t.Fatal("missing observation capability")
	}
	ctx := reply.Result.Context
	for i, operation := range []string{"", "forbidden-effect"} {
		params := map[string]any{"context": ctx, "body": map[string]any{}}
		if operation != "" {
			params["operationId"] = operation
		}
		writeConnectorJSON(t, client, map[string]any{"jsonrpc": "2.0", "id": []string{"observe", "forbidden-effect"}[i], "method": method, "params": params})
		readConnectorJSON(t, client, &reply)
		if i == 0 && (reply.Result == nil || reply.Result.Status != "ok") {
			t.Fatalf("read-only observation failed: %+v", reply)
		}
		if i == 1 && reply.Error == nil && (reply.Result == nil || reply.Result.Status == "ok") {
			t.Fatalf("effect-like observation accepted: %+v", reply)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("effect-like observation reached handler")
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func writeConnectorJSON(t *testing.T, w io.Writer, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err = ipc.WriteFrame(w, raw); err != nil {
		t.Fatal(err)
	}
}
func readConnectorJSON(t *testing.T, r io.Reader, value any) {
	t.Helper()
	raw, err := ipc.ReadFrame(r)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, value); err != nil {
		t.Fatal(err)
	}
}
func TestConnectionAuthThenCanonicalHandshakeAndClosedRoutes(t *testing.T) {
	client, config, calls, done := connectorFixture(t)
	writeConnectorJSON(t, client, wire.ComputerConnectorHello{Binding: config.Endpoint.Binding, Token: config.Endpoint.Token})
	var authenticated wire.ComputerConnectorBinding
	readConnectorJSON(t, client, &authenticated)
	if authenticated != config.Endpoint.Binding {
		t.Fatal("crossed auth acknowledgement")
	}
	writeConnectorJSON(t, client, map[string]any{"jsonrpc": "2.0", "id": "hello", "method": "core.handshake", "params": map[string]any{"body": wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: "build", ProfileId: "profile"}}})
	var reply wire.Response
	readConnectorJSON(t, client, &reply)
	if reply.Result == nil || reply.Result.Status != "ok" || reply.Result.Context != (wire.Context{ProfileId: "profile", BackendGeneration: "backend"}) {
		t.Fatal("missing canonical handshake")
	}
	var identity wire.Identity
	if json.Unmarshal(reply.Result.Data, &identity) != nil || len(identity.Capabilities) != 2 {
		t.Fatal("unexpected exposed capabilities")
	}
	for i, method := range []string{"computer.workspace.list", "computer.authority.publish"} {
		id := []string{"list", "forbidden"}[i]
		params := map[string]any{"context": reply.Result.Context, "body": map[string]any{}}
		if i == 1 {
			params["operationId"] = "not-owned"
		}
		writeConnectorJSON(t, client, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		readConnectorJSON(t, client, &reply)
		if reply.Result == nil || i == 0 && reply.Result.Status != "ok" || i == 1 && reply.Result.Status != "unavailable" {
			t.Fatal("route exposure mismatch")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("unexpected module dispatch")
	}
	_ = client.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestConnectionWrongBindingOrSecretNeverReachesModule(t *testing.T) {
	for _, field := range []string{"token", "build", "profile", "backend", "runtime", "generation"} {
		t.Run(field, func(t *testing.T) {
			client, config, calls, done := connectorFixture(t)
			hello := wire.ComputerConnectorHello{Binding: config.Endpoint.Binding, Token: config.Endpoint.Token}
			switch field {
			case "token":
				hello.Token = strings.Repeat("b", 64)
			case "build":
				hello.Binding.BuildId = "other"
			case "profile":
				hello.Binding.ProfileId = "other"
			case "backend":
				hello.Binding.BackendGeneration = "other"
			case "runtime":
				hello.Binding.RuntimeId = "other"
			case "generation":
				hello.Binding.ConnectorGeneration = "9007199254740994"
			}
			writeConnectorJSON(t, client, hello)
			if _, err := ipc.ReadFrame(client); err == nil {
				t.Fatal("wrong identity authenticated")
			}
			if err := <-done; err != ErrConnectorUnavailable || calls.Load() != 0 {
				t.Fatal("wrong identity reached module")
			}
		})
	}
}
func TestConnectionBoundsHelloBeforeBodyAllocation(t *testing.T) {
	for _, size := range []uint32{0, 8193, 1048576, ^uint32(0)} {
		t.Run(string(rune(size%20+'a')), func(t *testing.T) {
			client, _, calls, done := connectorFixture(t)
			var header [4]byte
			binary.BigEndian.PutUint32(header[:], size)
			if _, err := client.Write(header[:]); err != nil {
				t.Fatal(err)
			}
			if _, err := ipc.ReadFrame(client); err == nil {
				t.Fatal("oversized hello accepted")
			}
			if err := <-done; err != ErrConnectorUnavailable || calls.Load() != 0 {
				t.Fatal("invalid auth dispatched")
			}
		})
	}
}
func TestConnectionRejectsDuplicateHelloAndAuthorityRegistration(t *testing.T) {
	client, config, calls, done := connectorFixture(t)
	raw, _ := json.Marshal(wire.ComputerConnectorHello{Binding: config.Endpoint.Binding, Token: config.Endpoint.Token})
	raw = append([]byte(`{"token":"`+config.Endpoint.Token+`",`), raw[1:]...)
	if err := ipc.WriteFrame(client, raw); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != ErrConnectorUnavailable || calls.Load() != 0 {
		t.Fatal("duplicate accepted")
	}
	config.Methods["computer.authority.publish"] = config.Methods["computer.workspace.list"]
	if validateConnectorConfig(config) == nil {
		t.Fatal("authority issuer exposed to MCP")
	}
}

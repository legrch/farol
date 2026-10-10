//go:build darwin

package desktop

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

func TestNativeConnectorSocketLaunchPublicationRefusesAppendedByte(t *testing.T) {
	f := newNativeConnector(t, nil)
	name := filepath.Join(f.listener.root, "computer-go-launch.json")
	f.listener.beforeLaunchReadback = func() {
		file, err := os.OpenFile(name, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, writeErr := file.Write([]byte(" "))
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			t.Fatal("append fixture failed", writeErr, closeErr)
		}
	}
	data := []byte("synthetic-complete-launch\n")
	published, digest, err := f.listener.PublishLaunch(context.Background(), data)
	f.remember(t, name)
	if err == nil || published != "" || digest != "" {
		t.Fatal("appended byte accepted as an exact publication")
	}
	if _, _, err := f.listener.PublishLaunch(context.Background(), data); err == nil {
		t.Fatal("refused publication retried")
	}
	actual, err := os.ReadFile(name)
	if err != nil || !bytes.Equal(actual, append(data, ' ')) {
		t.Fatal("refused publication evidence changed", err)
	}
	nativeConnectorClose(t, f)
}

func TestNativeConnectorSocketLaunchPublicationAnchorsSecretWrite(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(map[bool]string{false: "original", true: "parent-substitution"}[replace], func(t *testing.T) {
			f := newNativeConnector(t, nil)
			root := f.listener.root
			original := root
			var destination string
			if replace {
				holder, err := os.MkdirTemp("/private/tmp", "farol-native-launch-")
				if err != nil {
					t.Fatal(err)
				}
				f.remember(t, holder)
				destination = filepath.Join(holder, "destination")
				if err := os.Mkdir(destination, 0700); err != nil {
					t.Fatal(err)
				}
				f.remember(t, destination)
				original = filepath.Join(holder, "original")
				f.listener.beforeLaunchOpen = func() {
					if err := os.Rename(root, original); err != nil {
						t.Fatal(err)
					}
					f.owned[original], f.owned[filepath.Join(original, "computer.sock")] = f.owned[root], f.owned[f.listener.Endpoint().SocketPath]
					delete(f.owned, root)
					delete(f.owned, f.listener.Endpoint().SocketPath)
					if err := os.Symlink(destination, root); err != nil {
						t.Fatal(err)
					}
					f.remember(t, root)
				}
			}
			data := []byte("synthetic-token-must-stay-in-qualified-root\n")
			published, digest, err := f.listener.PublishLaunch(context.Background(), data)
			name := filepath.Join(original, "computer-go-launch.json")
			f.remember(t, name)
			actual, readErr := os.ReadFile(name)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if replace {
				if err == nil || len(actual) != 0 {
					t.Fatal("substitution published secret bytes")
				}
				if entries, err := os.ReadDir(destination); err != nil || len(entries) != 0 {
					t.Fatal("substituted destination received a file")
				}
			} else {
				hash := sha256.Sum256(data)
				if err != nil || published != name || digest != hex.EncodeToString(hash[:]) || !bytes.Equal(actual, data) {
					t.Fatal("publication did not retain exact bytes", err)
				}
				info, err := os.Lstat(name)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Fatal("launch file mode")
				}
			}
			if _, _, err := f.listener.PublishLaunch(context.Background(), data); err == nil {
				t.Fatal("publication attempt retried")
			}
			nativeConnectorClose(t, f)
		})
	}
}

// These tests require the sole disposable native lane. They qualify Darwin UDS
// transport only: no Electron, provider, module policy, child or package evidence.
// Do not run in parallel. Every wait is bounded; a timeout is never a rejection.
const nativeConnectorWait = 3 * time.Second

type nativeConnectorFixture struct {
	listener *ConnectorListener
	cancel   context.CancelFunc
	calls    atomic.Int32
	owned    map[string]os.FileInfo
	preserve bool
}

func newNativeConnector(t *testing.T, handle func(context.Context, Request) (*Outcome, error)) *nativeConnectorFixture {
	t.Helper()
	f := &nativeConnectorFixture{owned: make(map[string]os.FileInfo)}
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	binding := wire.ComputerConnectorBinding{BuildId: "native-build", ProfileId: "native-profile", BackendGeneration: "native-backend", RuntimeId: "native-connector", ConnectorGeneration: "9007199254740993"}
	listener, err := StartConnector(ctx, binding, map[string]Method{"computer.workspace.list": {Handle: func(ctx context.Context, req Request) (*Outcome, error) {
		f.calls.Add(1)
		if handle != nil {
			return handle(ctx, req)
		}
		return &Outcome{Status: "ok", Data: json.RawMessage(`{"native":true}`)}, nil
	}}})
	if err != nil {
		cancel()
		// StartConnector does not report a partially created root. Do not search
		// for or reclaim paths whose ownership cannot be established.
		t.Fatal("StartConnector failed; any partial endpoint is preserved:", err)
	}
	f.listener = listener
	f.owned[listener.root] = listener.rootInfo
	f.owned[listener.Endpoint().SocketPath] = listener.socketInfo
	t.Cleanup(func() {
		cancel()
		ctx, stop := context.WithTimeout(context.Background(), nativeConnectorWait)
		defer stop()
		if err := listener.Close(ctx); err != nil {
			t.Errorf("listener settlement unknown; preserve %s: %v", listener.root, err)
			return
		}
		if f.preserve {
			t.Errorf("path ownership unknown; preserve %s", listener.root)
			return
		}
		// Inspect the complete exact manifest before removing anything. Avoid
		// TempDir/RemoveAll: neither may erase evidence after an uncertain Close.
		paths := make([]string, 0, len(f.owned))
		for path, expected := range f.owned {
			current, err := os.Lstat(path)
			if err != nil || !os.SameFile(expected, current) || expected.Mode().Type() != current.Mode().Type() {
				t.Errorf("owned path changed; preserve %s", path)
				return
			}
			if current.IsDir() {
				entries, err := os.ReadDir(path)
				if err != nil {
					t.Errorf("cannot inspect owned root; preserve %s: %v", path, err)
					return
				}
				for _, entry := range entries {
					if _, ok := f.owned[filepath.Join(path, entry.Name())]; !ok {
						t.Errorf("unexpected entry; preserve %s", path)
						return
					}
				}
			}
			paths = append(paths, path)
		}
		sort.Slice(paths, func(i, j int) bool { return len(paths[i]) > len(paths[j]) })
		for _, path := range paths {
			if err := os.Remove(path); err != nil {
				t.Errorf("exact owned cleanup stopped at %s: %v", path, err)
				return
			}
		}
	})
	return f
}

func (f *nativeConnectorFixture) remember(t *testing.T, path string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		f.preserve = true
		t.Fatal("cannot record exact owned path:", err)
	}
	f.owned[path] = info
}

func nativeConnectorDial(t *testing.T, path string) *net.UnixConn {
	t.Helper()
	connection, err := net.DialTimeout("unix", path, nativeConnectorWait)
	if err != nil {
		t.Fatal("native dial:", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	client, ok := connection.(*net.UnixConn)
	if !ok {
		t.Fatal("dial did not return a native Unix connection")
	}
	nativeConnectorDeadline(t, client)
	return client
}

func nativeConnectorDeadline(t *testing.T, client net.Conn) {
	t.Helper()
	if err := client.SetDeadline(time.Now().Add(nativeConnectorWait)); err != nil {
		t.Fatal(err)
	}
}

func nativeConnectorConnections(t *testing.T, listener *ConnectorListener, want int) {
	t.Helper()
	deadline := time.NewTimer(nativeConnectorWait)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		listener.mu.Lock()
		count := len(listener.connections)
		listener.mu.Unlock()
		if count == want {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("native connection settlement timed out: got %d, want %d", count, want)
		case <-tick.C:
		}
	}
}

func nativeConnectorClosed(t *testing.T, client net.Conn) {
	t.Helper()
	nativeConnectorDeadline(t, client)
	if err := connectorCloseProof(client, nil); err != nil {
		t.Fatal(err)
	}
}

func nativeConnectorClosedForOwner(t *testing.T, client net.Conn, request wire.Request) {
	t.Helper()
	nativeConnectorDeadline(t, client)
	if err := connectorCloseProof(client, &request); err != nil {
		t.Fatal(err)
	}
}

func nativeConnectorClose(t *testing.T, f *nativeConnectorFixture) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), nativeConnectorWait)
	defer cancel()
	if err := f.listener.Close(ctx); err != nil {
		t.Fatal("native Close did not settle:", err)
	}
	nativeConnectorConnections(t, f.listener, 0)
}

func nativeConnectorAuth(t *testing.T, client net.Conn, endpoint wire.ComputerConnectorEndpoint) {
	t.Helper()
	nativeConnectorDeadline(t, client)
	writeConnectorJSON(t, client, wire.ComputerConnectorHello{Binding: endpoint.Binding, Token: endpoint.Token})
	var ack wire.ComputerConnectorBinding
	readConnectorJSON(t, client, &ack)
	if ack != endpoint.Binding {
		t.Fatal("native authentication acknowledgement crossed binding")
	}
}

func nativeConnectorHandshake(t *testing.T, client net.Conn, endpoint wire.ComputerConnectorEndpoint) wire.Context {
	t.Helper()
	b := endpoint.Binding
	nativeConnectorDeadline(t, client)
	writeConnectorJSON(t, client, wire.Request{Jsonrpc: "2.0", Id: "hello", Method: "core.handshake", Params: wire.Call{Body: nativeConnectorHandshakeBody(t, b)}})
	var reply wire.Response
	readConnectorJSON(t, client, &reply)
	bound := wire.Context{ProfileId: b.ProfileId, BackendGeneration: b.BackendGeneration}
	if reply.Jsonrpc != "2.0" || reply.Id == nil || *reply.Id != "hello" || reply.Error != nil || reply.Result == nil || reply.Result.Status != "ok" || reply.Result.RequestId != "hello" || reply.Result.Context != bound || reply.Result.OperationId != nil {
		t.Fatal("native canonical handshake response mismatch")
	}
	var identity wire.Identity
	if err := json.Unmarshal(reply.Result.Data, &identity); err != nil {
		t.Fatal(err)
	}
	expected := wire.Identity{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: b.BuildId, ProfileId: b.ProfileId, BackendGeneration: b.BackendGeneration, Capabilities: []string{"core.status", "computer.workspace.list"}, MaxFrameBytes: ipc.MaxFrameBytes}
	if !reflect.DeepEqual(identity, expected) {
		t.Fatal("native canonical identity/capabilities mismatch")
	}
	return bound
}

func nativeConnectorHandshakeBody(t *testing.T, b wire.ComputerConnectorBinding) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: b.BuildId, ProfileId: b.ProfileId})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func nativeConnectorRequest(t *testing.T, client net.Conn, id, method string, bound wire.Context, operation *string) wire.Response {
	t.Helper()
	nativeConnectorDeadline(t, client)
	writeConnectorJSON(t, client, wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: wire.Call{Context: &bound, OperationId: operation, Body: json.RawMessage(`{}`)}})
	var reply wire.Response
	readConnectorJSON(t, client, &reply)
	if reply.Jsonrpc != "2.0" || reply.Id == nil || *reply.Id != id {
		t.Fatal("uncorrelated native response")
	}
	return reply
}

func nativeConnectorRetainedInert(t *testing.T, f *nativeConnectorFixture, path string, root string) {
	t.Helper()
	for _, exact := range []string{root, path} {
		info, err := os.Lstat(exact)
		if err != nil || !os.SameFile(f.owned[exact], info) {
			t.Fatalf("Close removed/replaced retained endpoint evidence: %s", exact)
		}
	}
	connection, err := net.DialTimeout("unix", path, nativeConnectorWait)
	if connection != nil {
		_ = connection.Close()
	}
	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("retained endpoint did not refuse a new connection: %v", err)
	}
}

func TestNativeConnectorSocketPrivateRootAndIdentity(t *testing.T) {
	f := newNativeConnector(t, nil)
	other := newNativeConnector(t, nil)
	endpoint := f.listener.Endpoint()
	root := filepath.Dir(endpoint.SocketPath)
	if root != f.listener.root || filepath.Dir(root) != "/private/tmp" || filepath.Base(endpoint.SocketPath) != "computer.sock" {
		t.Fatal("connector did not select its own private native path")
	}
	if root == other.listener.root || endpoint.Token == other.listener.Endpoint().Token {
		t.Fatal("independent connector lifetimes reused a path or secret")
	}
	for _, path := range []string{root, endpoint.SocketPath} {
		canonical, err := filepath.EvalSymlinks(path)
		if err != nil || canonical != path {
			t.Fatalf("noncanonical native path: %s", path)
		}
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(os.Getuid()) {
			t.Fatal("native path is not owned by the current user")
		}
		if path == root {
			if !info.IsDir() || info.Mode().Perm() != 0700 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
				t.Fatal("native root is not a private ordinary 0700 directory")
			}
		} else if info.Mode()&os.ModeSocket == 0 || stat.Nlink != 1 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
			t.Fatal("native endpoint is not a singly linked ordinary socket")
		}
	}
	if !safeConnectorRoot(root, f.owned[root]) || !safeConnectorSocket(f.owned[endpoint.SocketPath]) || !f.listener.pathsCurrent() {
		t.Fatal("fresh native paths failed qualification")
	}
	raw, err := json.Marshal(endpoint)
	if err != nil || wire.Validate("ComputerConnectorEndpoint", raw) != nil {
		t.Fatal("native endpoint violates its wire contract")
	}
	nativeConnectorClose(t, f)
	nativeConnectorRetainedInert(t, f, endpoint.SocketPath, root)
}

func TestNativeConnectorSocketSameUserAuthCanonicalHandshakeAndRoutes(t *testing.T) {
	requests := make(chan Request, 1)
	f := newNativeConnector(t, func(_ context.Context, req Request) (*Outcome, error) {
		select {
		case requests <- req:
		default:
			return nil, errors.New("unexpected additional native dispatch")
		}
		return &Outcome{Status: "ok", Data: json.RawMessage(`{"native":true}`)}, nil
	})
	endpoint := f.listener.Endpoint()
	client := nativeConnectorDial(t, endpoint.SocketPath)
	// Actual Darwin LOCAL_PEERCRED on a real same-user socket. No alternate
	// uid/account is created; different-user rejection remains outside this suite.
	if !sameConnectorUser(client) {
		t.Fatal("actual same-user native peer credentials failed")
	}
	nativeConnectorAuth(t, client, endpoint)
	bound := wire.Context{ProfileId: endpoint.Binding.ProfileId, BackendGeneration: endpoint.Binding.BackendGeneration}
	before := nativeConnectorRequest(t, client, "before", "computer.workspace.list", bound, nil)
	if before.Error == nil || before.Error.Code != -32001 || f.calls.Load() != 0 {
		t.Fatal("native auth bypassed canonical handshake")
	}
	bound = nativeConnectorHandshake(t, client, endpoint)
	reply := nativeConnectorRequest(t, client, "list", "computer.workspace.list", bound, nil)
	if reply.Error != nil || reply.Result == nil || reply.Result.Status != "ok" || reply.Result.RequestId != "list" || reply.Result.Context != bound || reply.Result.OperationId != nil || string(reply.Result.Data) != `{"native":true}` {
		t.Fatal("allowed native route did not return the owner response")
	}
	select {
	case req := <-requests:
		if req.RequestID != "list" || req.OperationID != "" || string(req.Body) != `{}` {
			t.Fatal("native route changed owner request identity")
		}
	case <-time.After(nativeConnectorWait):
		t.Fatal("native owner request was not observed")
	}
	reply = nativeConnectorRequest(t, client, "forbidden", "computer.authority.publish", bound, optional("not-owned"))
	if reply.Error != nil || reply.Result == nil || reply.Result.Status != "unavailable" || reply.Result.Code == nil || *reply.Result.Code != "capability_unavailable" {
		t.Fatal("connector exposed an authority issuer")
	}
	stale := bound
	stale.BackendGeneration = "old-backend"
	reply = nativeConnectorRequest(t, client, "stale", "computer.workspace.list", stale, nil)
	if reply.Error == nil || reply.Error.Code != -32002 {
		t.Fatal("stale native context was accepted")
	}
	reply = nativeConnectorRequest(t, client, "list", "computer.workspace.list", bound, nil)
	if reply.Error == nil || reply.Error.Code != -32600 || f.calls.Load() != 1 {
		t.Fatal("duplicate/stale/forbidden request dispatched")
	}
	nativeConnectorClose(t, f)
	nativeConnectorClosed(t, client)
}

// Pipeline a valid canonical handshake and allowed route behind an invalid hello.
// A refusal must close the real stream before any queued owner work can run.
func nativeConnectorRejectedPipeline(t *testing.T, client net.Conn, hello wire.ComputerConnectorHello, binding wire.ComputerConnectorBinding) {
	t.Helper()
	var packet bytes.Buffer
	writeConnectorJSON(t, &packet, hello)
	writeConnectorJSON(t, &packet, wire.Request{Jsonrpc: "2.0", Id: "hello", Method: "core.handshake", Params: wire.Call{Body: nativeConnectorHandshakeBody(t, binding)}})
	bound := wire.Context{ProfileId: binding.ProfileId, BackendGeneration: binding.BackendGeneration}
	writeConnectorJSON(t, &packet, wire.Request{Jsonrpc: "2.0", Id: "queued", Method: "computer.workspace.list", Params: wire.Call{Context: &bound, Body: json.RawMessage(`{}`)}})
	nativeConnectorDeadline(t, client)
	if _, err := io.Copy(client, &packet); err != nil && !errors.Is(err, syscall.EPIPE) && !errors.Is(err, syscall.ECONNRESET) {
		t.Fatal("unexpected pipeline write failure:", err)
	}
	nativeConnectorClosed(t, client)
}

func TestNativeConnectorSocketWrongAuthOrBindingNeverDispatches(t *testing.T) {
	f := newNativeConnector(t, nil)
	endpoint := f.listener.Endpoint()
	for _, field := range []string{"token", "build", "profile", "backend", "runtime", "generation"} {
		t.Run(field, func(t *testing.T) {
			hello := wire.ComputerConnectorHello{Binding: endpoint.Binding, Token: endpoint.Token}
			switch field {
			case "token":
				if hello.Token[0] == 'a' {
					hello.Token = "b" + hello.Token[1:]
				} else {
					hello.Token = "a" + hello.Token[1:]
				}
			case "build":
				hello.Binding.BuildId = "other-build"
			case "profile":
				hello.Binding.ProfileId = "other-profile"
			case "backend":
				hello.Binding.BackendGeneration = "other-backend"
			case "runtime":
				hello.Binding.RuntimeId = "other-runtime"
			case "generation":
				hello.Binding.ConnectorGeneration = "9007199254740994"
			}
			raw, err := json.Marshal(hello)
			if err != nil || wire.Validate("ComputerConnectorHello", raw) != nil {
				t.Fatal("negative fixture is malformed rather than mismatched")
			}
			client := nativeConnectorDial(t, endpoint.SocketPath)
			nativeConnectorRejectedPipeline(t, client, hello, endpoint.Binding)
			nativeConnectorConnections(t, f.listener, 0)
			if f.calls.Load() != 0 {
				t.Fatal("invalid native identity reached the owner")
			}
		})
	}
	nativeConnectorClose(t, f)
	if f.calls.Load() != 0 {
		t.Fatal("queued owner dispatch appeared after refusal")
	}
}

func TestNativeConnectorSocketCloseOrCancelTerminatesExactStreams(t *testing.T) {
	for _, trigger := range []string{"close", "cancel"} {
		t.Run(trigger, func(t *testing.T) {
			entered, canceled := make(chan struct{}), make(chan struct{})
			f := newNativeConnector(t, func(ctx context.Context, _ Request) (*Outcome, error) {
				close(entered)
				select {
				case <-ctx.Done():
					close(canceled)
					return nil, ctx.Err()
				case <-time.After(2 * nativeConnectorWait):
					return nil, errors.New("native fixture owner cancellation timed out")
				}
			})
			other := newNativeConnector(t, nil)
			endpoint := f.listener.Endpoint()
			var clients []*net.UnixConn
			var ownerActive *net.UnixConn
			var originalRequest wire.Request
			for _, phase := range []string{"idle-auth", "partial-header", "partial-body", "authenticated", "handshaken", "owner-active"} {
				client := nativeConnectorDial(t, endpoint.SocketPath)
				clients = append(clients, client)
				switch phase {
				case "partial-header":
					if _, err := client.Write([]byte{0, 0}); err != nil {
						t.Fatal(err)
					}
				case "partial-body":
					if _, err := client.Write([]byte{0, 0, 0, 10, '{'}); err != nil {
						t.Fatal(err)
					}
				case "authenticated", "handshaken", "owner-active":
					nativeConnectorAuth(t, client, endpoint)
					if phase != "authenticated" {
						bound := nativeConnectorHandshake(t, client, endpoint)
						if phase == "owner-active" {
							ownerActive = client
							originalRequest = wire.Request{Jsonrpc: "2.0", Id: "active", Method: "computer.workspace.list", Params: wire.Call{Context: &bound, Body: json.RawMessage(`{}`)}}
							writeConnectorJSON(t, client, originalRequest)
						}
					}
				}
				// Do not depend on sleeps or assume dial means accept completed.
				nativeConnectorConnections(t, f.listener, len(clients))
			}
			select {
			case <-entered:
			case <-time.After(nativeConnectorWait):
				t.Fatal("native owner did not enter")
			}
			if trigger == "cancel" {
				f.cancel()
				select {
				case <-f.listener.closeDone:
				case <-time.After(nativeConnectorWait):
					t.Fatal("parent cancellation did not settle the native listener")
				}
			}
			nativeConnectorClose(t, f)
			select {
			case <-canceled:
			default:
				t.Fatal("successful Close preceded owner cancellation settlement")
			}
			for _, client := range clients {
				if client == ownerActive {
					// Cancellation may race one fully buffered original terminal
					// response; every other stream retains strict no-frame closure.
					nativeConnectorClosedForOwner(t, client, originalRequest)
				} else {
					nativeConnectorClosed(t, client)
				}
			}
			if f.calls.Load() != 1 {
				t.Fatal("shutdown dispatched unexpected owner work")
			}
			nativeConnectorRetainedInert(t, f, endpoint.SocketPath, f.listener.root)
			// Repeated Close observes the same settled handles and retains the paths.
			nativeConnectorClose(t, f)
			nativeConnectorRetainedInert(t, f, endpoint.SocketPath, f.listener.root)
			otherEndpoint := other.listener.Endpoint()
			otherClient := nativeConnectorDial(t, otherEndpoint.SocketPath)
			nativeConnectorAuth(t, otherClient, otherEndpoint)
			bound := nativeConnectorHandshake(t, otherClient, otherEndpoint)
			reply := nativeConnectorRequest(t, otherClient, "still-live", "computer.workspace.list", bound, nil)
			if reply.Result == nil || reply.Result.Status != "ok" || other.calls.Load() != 1 {
				t.Fatal("shutdown affected an independent native connector")
			}
		})
	}
}

func TestNativeConnectorSocketCloseDeadlineRetainsUnsettledOwner(t *testing.T) {
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	f := newNativeConnector(t, func(context.Context, Request) (*Outcome, error) {
		close(entered)
		// Model an owner whose work does not settle on stream cancellation,
		// with a fixture-only final bound if assertions/cleanup cannot release it.
		select {
		case <-release:
		case <-time.After(2 * nativeConnectorWait):
		}
		close(returned)
		return &Outcome{Status: "ok"}, nil
	})
	// Release precedes fixture cleanup even after a failed assertion. No orphan
	// handler may force a cleanup that pretends Close succeeded.
	var releaseOnce sync.Once
	releaseOwner := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseOwner)
	endpoint := f.listener.Endpoint()
	client := nativeConnectorDial(t, endpoint.SocketPath)
	nativeConnectorAuth(t, client, endpoint)
	bound := nativeConnectorHandshake(t, client, endpoint)
	writeConnectorJSON(t, client, wire.Request{Jsonrpc: "2.0", Id: "blocked", Method: "computer.workspace.list", Params: wire.Call{Context: &bound, Body: json.RawMessage(`{}`)}})
	select {
	case <-entered:
	case <-time.After(nativeConnectorWait):
		t.Fatal("native unsettled owner did not enter")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := f.listener.Close(ctx)
	if !errors.Is(err, ErrConnectorUnavailable) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close misclassified unsettled owner: %v", err)
	}
	nativeConnectorClosed(t, client)
	select {
	case <-returned:
		t.Fatal("Close claimed cancellation of owner work")
	case <-f.listener.closeDone:
		t.Fatal("Close marked an unsettled owner complete")
	default:
	}
	nativeConnectorRetainedInert(t, f, endpoint.SocketPath, f.listener.root)
	if f.calls.Load() != 1 {
		t.Fatal("Close replayed owner work")
	}
	releaseOwner()
	nativeConnectorClose(t, f)
	select {
	case <-returned:
	default:
		t.Fatal("settled Close preceded explicit owner release")
	}
	nativeConnectorRetainedInert(t, f, endpoint.SocketPath, f.listener.root)
	// A second Close observes the original shutdown after explicit owner release;
	// it proves neither cancellation of owner work nor acceptance of its result.
}

func TestNativeConnectorSocketChangedPathsNeverDispatch(t *testing.T) {
	for _, change := range []string{"root-mode", "root-identity", "root-symlink", "socket-file", "socket-identity", "socket-symlink"} {
		t.Run(change, func(t *testing.T) {
			f := newNativeConnector(t, nil)
			endpoint := f.listener.Endpoint()
			root, dialPath := f.listener.root, endpoint.SocketPath
			switch change {
			case "root-mode":
				if err := os.Chmod(root, 0755); err != nil {
					t.Fatal(err)
				}
			case "root-identity", "root-symlink":
				holder, err := os.MkdirTemp("/private/tmp", "farol-native-")
				if err != nil {
					t.Fatal(err)
				}
				f.remember(t, holder)
				moved := filepath.Join(holder, "moved")
				if err := os.Rename(root, moved); err != nil {
					t.Fatal(err)
				}
				dialPath = filepath.Join(moved, "computer.sock")
				f.owned[moved], f.owned[dialPath] = f.owned[root], f.owned[endpoint.SocketPath]
				delete(f.owned, root)
				delete(f.owned, endpoint.SocketPath)
				if change == "root-identity" {
					err = os.Mkdir(root, 0700)
				} else {
					err = os.Symlink(moved, root)
				}
				if err != nil {
					f.preserve = true
					t.Fatal(err)
				}
				f.remember(t, root)
			default:
				dialPath = filepath.Join(root, "original.sock")
				if err := os.Rename(endpoint.SocketPath, dialPath); err != nil {
					t.Fatal(err)
				}
				f.owned[dialPath] = f.owned[endpoint.SocketPath]
				delete(f.owned, endpoint.SocketPath)
				var err error
				switch change {
				case "socket-file":
					file, createErr := os.OpenFile(endpoint.SocketPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
					err = createErr
					if err == nil {
						err = file.Close()
					}
				case "socket-identity":
					var replacement *net.UnixListener
					replacement, err = net.ListenUnix("unix", &net.UnixAddr{Name: endpoint.SocketPath, Net: "unix"})
					if err == nil {
						replacement.SetUnlinkOnClose(false)
						err = replacement.Close()
					}
				case "socket-symlink":
					err = os.Symlink(dialPath, endpoint.SocketPath)
				}
				if err != nil {
					f.preserve = true
					t.Fatal("replacement path creation/handle settlement unknown:", err)
				}
				f.remember(t, endpoint.SocketPath)
			}
			if f.listener.pathsCurrent() {
				t.Fatal("changed native path still qualified")
			}
			// Dial the relocated ORIGINAL listener, not a replacement endpoint.
			// This demonstrates native accept-time refusal, rather than ENOENT or
			// a client-side dial refusal being mistaken for a dispatch gate.
			client := nativeConnectorDial(t, dialPath)
			nativeConnectorRejectedPipeline(t, client, wire.ComputerConnectorHello{Binding: endpoint.Binding, Token: endpoint.Token}, endpoint.Binding)
			nativeConnectorClose(t, f)
			if f.calls.Load() != 0 {
				t.Fatal("changed native path dispatched queued owner work")
			}
			for path, expected := range f.owned {
				info, err := os.Lstat(path)
				if err != nil || !os.SameFile(expected, info) {
					t.Fatalf("Close removed/replaced original or replacement evidence: %s", path)
				}
			}
		})
	}
}

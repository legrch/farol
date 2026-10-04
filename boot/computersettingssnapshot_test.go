package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Composed owner/contract/transport checks with injected storage/native reads.
// No file, process, Chat turn, mutation or provider is created by this fixture.
type settingsSnapshotNative struct {
	calls   int
	after   func()
	request port.ReadRequest
}

func (n *settingsSnapshotNative) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.calls++
	n.request = r
	if n.after != nil {
		n.after()
	}
	raw := []byte("\xef\xbb\xbfhello\r\n")
	digest := sha256.Sum256(raw)
	return &port.ReadResponse{Text: string(raw[3:]), Bytes: uint64(len(raw)), SHA256: hex.EncodeToString(digest[:])}, nil
}
func (*settingsSnapshotNative) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	return nil, errors.New("snapshot must not list")
}
func snapshotFixture(t *testing.T) (*ComputerIngress, *settingsStoreFixture, *settingsSnapshotNative, wire.ComputerSettingsSnapshotRequest) {
	t.Helper()
	root, store, _, list := settingsFixture(t)
	store.approval.Capabilities = []authority.Capability{authority.Read}
	root.publication.approval = store.approval.Clone()
	native := &settingsSnapshotNative{}
	root.native = native
	return root, store, native, wire.ComputerSettingsSnapshotRequest{Publication: list.Publication, WorkspaceId: list.WorkspaceId, RelativePath: "note.md"}
}
func TestSettingsSnapshotUsesPublishedOwnerWithoutChatOrText(t *testing.T) {
	root, store, native, in := snapshotFixture(t)
	body, _ := json.Marshal(in)
	out, err := root.Methods()["computer.settings.snapshot"].Handle(context.Background(), desktop.Request{RequestID: "snapshot", Body: body})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerSettingsSnapshotResponse", out.Data) != nil {
		t.Fatalf("snapshot: %+v %v", out, err)
	}
	var result wire.ComputerSettingsSnapshotResponse
	if json.Unmarshal(out.Data, &result) != nil || result.Publication != in.Publication || result.WorkspaceId != in.WorkspaceId || result.RelativePath != in.RelativePath || result.Bytes != 10 || result.Root.Inode != "2" || len(result.Sha256) != 64 {
		t.Fatalf("wrong snapshot: %s", out.Data)
	}
	if strings.Contains(string(out.Data), "hello") || strings.Contains(string(out.Data), "\"text\"") || native.calls != 1 || native.request.Range != nil || root.chat != nil || store.admits != 0 || len(root.tasks) != 0 || len(root.turns) != 0 || store.revision != 4 {
		t.Fatal("body escaped or side effects occurred")
	}
}
func TestSettingsSnapshotCrossedPublicationNeverReads(t *testing.T) {
	for _, key := range []string{"fence", "revision", "generation", "operation", "digest", "workspace"} {
		t.Run(key, func(t *testing.T) {
			root, _, native, in := snapshotFixture(t)
			switch key {
			case "fence":
				in.Publication.Fence = "9"
			case "revision":
				in.Publication.StoreRevision = "9"
			case "generation":
				in.Publication.Generation = "9"
			case "operation":
				in.Publication.PublishOperationId = "other"
			case "digest":
				in.Publication.ApprovalDigest = strings.Repeat("b", 64)
			case "workspace":
				in.WorkspaceId = "outside"
			}
			out, err := root.settingsSnapshot(context.Background(), in)
			if err == nil || out != nil || native.calls != 0 {
				t.Fatalf("crossed %s reached read: %+v %v calls=%d", key, out, err, native.calls)
			}
		})
	}
}
func TestSettingsSnapshotFinalCurrentGuard(t *testing.T) {
	for _, change := range []string{"withdraw", "revision", "owner", "root", "expiry", "unknown", "publication"} {
		t.Run(change, func(t *testing.T) {
			root, store, native, in := snapshotFixture(t)
			native.after = func() {
				switch change {
				case "withdraw":
					_, _ = root.guard.deactivate()
				case "revision":
					store.revision++
				case "owner":
					store.approval.OwnerID = "other"
				case "root":
					store.approval.Workspaces[0].RootIdentity.Inode = "3"
				case "expiry":
					store.approval.ExpiresAt = root.clock.Now()
				case "unknown":
					root.unknown = true
				case "publication":
					root.publication = nil
				}
			}
			out, err := root.settingsSnapshot(context.Background(), in)
			if err == nil || out != nil || native.calls != 1 {
				t.Fatalf("late %s disclosed %+v %v calls=%d", change, out, err, native.calls)
			}
		})
	}
}
func TestSettingsSnapshotClosedWire(t *testing.T) {
	for _, input := range []string{`{}`, `{"publication":{},"workspaceId":"work","relativePath":"note.md","text":"bad"}`} {
		root, _, native, _ := snapshotFixture(t)
		out, err := root.Methods()["computer.settings.snapshot"].Handle(context.Background(), desktop.Request{RequestID: "bad", Body: []byte(input)})
		if err != nil || out == nil || out.Status != "refused" || native.calls != 0 {
			t.Fatalf("invalid request accepted %+v %v", out, err)
		}
	}
	root, _, native, in := snapshotFixture(t)
	body, _ := json.Marshal(in)
	out, err := root.Methods()["computer.settings.snapshot"].Handle(context.Background(), desktop.Request{RequestID: "effect", OperationID: "not-read", Body: body})
	if err != nil || out == nil || out.Status != "refused" || native.calls != 0 {
		t.Fatal("effect key accepted")
	}
}

func TestSettingsSnapshotWireWithdrawalWhileNativeWaits(t *testing.T) {
	root, store, native, request := snapshotFixture(t)
	// This real Server fixture supplies a real cancellation deadline; align the
	// injected clock with it, rather than comparing it with a synthetic future.
	now := time.Now().Truncate(time.Millisecond)
	root.clock.(*computerClockFixture).now = now
	store.approval.ExpiresAt = now.Add(time.Hour)
	root.publication.approval.ExpiresAt = store.approval.ExpiresAt
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	native.after = func() { close(entered); <-release }
	p := taskWireTestConnectMethods(t, root.Methods(), root.peer)
	requestFrame := func(id, method, operation string, body any) []byte {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: wire.Call{Context: &p.scope, OperationId: taskWireOptional(operation), Body: raw}})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	if err := ipc.WriteFrame(p.in, requestFrame("held-settings", "computer.settings.snapshot", "", request)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Settings never reached native Read")
	}
	type observed struct {
		raw []byte
		err error
	}
	ack := make(chan observed, 1)
	deactivation := requestFrame("withdraw-owner", "computer.authority.deactivate", "withdraw", map[string]any{})
	go func() {
		if err := ipc.WriteFrame(p.in, deactivation); err != nil {
			ack <- observed{err: err}
			return
		}
		raw, err := ipc.ReadFrame(p.out)
		ack <- observed{raw, err}
	}()
	select {
	case got := <-ack:
		var response wire.Response
		if got.err != nil || json.Unmarshal(got.raw, &response) != nil || response.Id == nil || *response.Id != "withdraw-owner" || response.Result == nil || response.Result.Status != "ok" {
			t.Fatalf("withdrawal did not ACK while native waited: %s %v", got.raw, got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("serial Settings handler blocked withdrawal")
	}
	close(release)
	raw, err := ipc.ReadFrame(p.out)
	var response wire.Response
	if err != nil || json.Unmarshal(raw, &response) != nil || response.Result == nil || response.Result.Status != "refused" || len(response.Result.Data) != 0 || native.calls != 1 {
		t.Fatalf("revoked native snapshot disclosed: %s %v", raw, err)
	}
}

//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

var authorityRenewalNativeEnabled = flag.Bool("authority-renewal-native", false, "Run bounded disposable native authority renewal Store/socket/File proof")

type renewalNativeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *renewalNativeClock) Now() time.Time    { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *renewalNativeClock) set(now time.Time) { c.mu.Lock(); c.now = now; c.mu.Unlock() }

// Real sole Store, journal, Darwin socket/IPC and native files; current consent
// is an explicit trusted-root fixture and time is modelled. No Electron, tunnel,
// actual ChatGPT caller, system-clock change or 72-hour live soak is claimed.
func TestNativeComputerRenewalSameSocketStoreSettingsAndRetainedMutation(t *testing.T) {
	if !*authorityRenewalNativeEnabled {
		t.Skip("Requires reserved native lane and -authority-renewal-native")
	}
	ctx := context.Background()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	private := func(name string) string {
		p := filepath.Join(base, name)
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
		return p
	}
	home := private("home")
	workspace := filepath.Join(home, "work")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	state := private("state")
	if err := os.Mkdir(filepath.Join(state, "mutations"), 0700); err != nil {
		t.Fatal(err)
	}
	// Keep controlled operation clocks behind real IPC deadlines at every step.
	// No production clock injection or selectable external test method is added.
	start := time.Now().Truncate(time.Millisecond).Add(-72 * time.Hour)
	clock := &renewalNativeClock{now: start}
	store, err := accessrepo.Create(state, accessrepo.Binding{ProfileID: "renewal-profile", OwnerID: "owner", ComputerID: "computer"}, clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	fileOwners, err := newComputerFileOwners(home)
	if err != nil {
		t.Fatal(err)
	}
	root := &ComputerIngress{store: store, native: fileOwners, clock: clock, peer: wire.Context{ProfileId: "renewal-profile", BackendGeneration: "renewal-backend"}, ownerID: "owner", computerID: "computer", used: make(map[string]bool)}
	fence, err := root.Deactivate(ctx, "withdraw-initial")
	if err != nil {
		t.Fatal(err)
	}
	var ws, st unix.Stat_t
	if unix.Lstat(workspace, &ws) != nil || unix.Lstat(state, &st) != nil {
		t.Fatal("fixture physical identity unavailable")
	}
	raw, err := json.Marshal(map[string]any{"ownerId": "owner", "computerId": "computer", "generation": 1,
		"workspaces":    []any{map[string]any{"workspaceId": "work", "root": workspace, "access": "write", "rootIdentity": map[string]string{"device": fmt.Sprint(ws.Dev), "inode": fmt.Sprint(ws.Ino)}}},
		"excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read", "workspace.search", "workspace.write"}, "network": "none", "commands": "none", "filePolicy": "approved-roots-v1", "expiresAt": start.Add(authority.TaskGrantLifetime).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	renewable := true
	publication, err := root.Publish(ctx, "original-owner-publication", wire.ComputerAuthorityPublishRequest{Fence: fence.Fence, ExpectedStoreRevision: fence.StoreRevision, SettingsRevision: "1", Approval: raw, RenewableOwnerConsent: &renewable})
	if err != nil {
		t.Fatal(err)
	}
	j, err := accessrepo.NewConnectorJournal(store)
	if err != nil {
		t.Fatal(err)
	}
	s, err := newComputerConnector(ctx, root, j, clock, func(ctx context.Context, b wire.ComputerConnectorBinding, m map[string]desktop.Method) (connectorEndpoint, error) {
		return desktop.StartConnector(ctx, b, m)
	})
	if err != nil {
		t.Fatal(err)
	}
	repo, err := mutationrepo.New(ctx, mutationrepo.Root{Path: state, Device: uint64(st.Dev), Inode: uint64(st.Ino), OwnerUID: uint32(os.Geteuid())})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := repo.Close(); err != nil {
			t.Error(err)
		}
	})
	s.mutations, err = settingsMutationIngress(root, computerMutationDependencies{repository: repo, native: fileOwners, digester: filesystem.Digester{}})
	if err != nil {
		t.Fatal(err)
	}
	challenge := "disposable-renewal-challenge"
	digest := sha256.Sum256([]byte(challenge))
	challengeHash := hex.EncodeToString(digest[:])
	opened, err := s.Open(ctx, "original-connector-open", wire.ComputerConnectorOpen{Publication: *publication, RuntimeId: "same-runtime", ConnectorGeneration: "4", LaunchDigest: strings.Repeat("b", 64), ChallengeSha256: &challengeHash})
	if err != nil {
		t.Fatal(err)
	}
	socketRoot := filepath.Dir(opened.Endpoint.SocketPath)
	rootInfo, e1 := os.Lstat(socketRoot)
	socketInfo, e2 := os.Lstat(opened.Endpoint.SocketPath)
	if e1 != nil || e2 != nil {
		t.Fatal("socket identity unavailable")
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
			return
		}
		if t.Failed() {
			return
		}
		a, e1 := os.Lstat(socketRoot)
		b, e2 := os.Lstat(opened.Endpoint.SocketPath)
		if e1 != nil || e2 != nil || !os.SameFile(a, rootInfo) || !os.SameFile(b, socketInfo) {
			t.Error("socket cleanup identity changed")
			return
		}
		if err := os.Remove(opened.Endpoint.SocketPath); err != nil {
			t.Error(err)
			return
		}
		if err := os.Remove(socketRoot); err != nil {
			t.Error(err)
		}
	})
	stream, err := net.DialTimeout("unix", opened.Endpoint.SocketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stream.Close() })
	if stream.SetDeadline(time.Now().Add(20*time.Second)) != nil {
		t.Fatal("deadline unavailable")
	}
	writeNativeMutationJSON(t, stream, wire.ComputerConnectorHello{Binding: opened.Endpoint.Binding, Token: opened.Endpoint.Token})
	data, err := ipc.ReadFrame(stream)
	var ack wire.ComputerConnectorBinding
	if err != nil || json.Unmarshal(data, &ack) != nil || ack != opened.Endpoint.Binding {
		t.Fatal("same socket auth failed", err)
	}
	hello, _ := json.Marshal(wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: opened.Endpoint.Binding.BuildId, ProfileId: opened.Endpoint.Binding.ProfileId})
	writeNativeMutationJSON(t, stream, wire.Request{Jsonrpc: "2.0", Id: "hello", Method: "core.handshake", Params: wire.Call{Body: hello}})
	data, err = ipc.ReadFrame(stream)
	var response wire.Response
	if err != nil || json.Unmarshal(data, &response) != nil || response.Result == nil || response.Result.Status != "ok" {
		t.Fatal("same socket handshake failed", err)
	}
	p := &nativeMutationPeer{stream: stream, opened: *opened}
	e := opened.Execution
	verify := wire.ComputerConnectorVerify{Challenge: challenge, CallId: "original-verify", WorkspaceId: "work"}
	proof := p.call(t, "computer.connector.verify", "", verify)
	if proof.Status != "ok" {
		t.Fatal("initial verify", proof.Status, proof.Code)
	}
	var proofBefore wire.ComputerConnectorVerificationState
	if json.Unmarshal(proof.Data, &proofBefore) != nil || proofBefore.Receipt == nil {
		t.Fatal("no original proof")
	}
	write := wire.ComputerConnectorWrite{Execution: e, CallId: "original-write", WorkspaceId: "work", RelativePath: "sentinel.txt", Content: "before renewal\n"}
	first := nativeMutationResult(t, p.call(t, "computer.workspace.write", "original-write-operation", write), "completed")
	originalApproval := root.publication.approval.Clone()
	for _, hours := range []int{12, 24, 72} {
		clock.set(start.Add(time.Duration(hours) * time.Hour))
		read := wire.ComputerReadRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: fmt.Sprintf("read-%d", hours), WorkspaceId: "work", RelativePath: "sentinel.txt"}
		if got := p.call(t, "computer.workspace.read", "", read); got.Status != "ok" {
			t.Fatal("read after modeled hours", hours, got.Status, got.Code)
		}
		if got, err := root.settingsSnapshot(ctx, wire.ComputerSettingsSnapshotRequest{Publication: *publication, WorkspaceId: "work", RelativePath: "sentinel.txt"}); err != nil || got == nil {
			t.Fatal("current Settings", hours, err)
		}
		retained := nativeMutationResult(t, p.call(t, "computer.workspace.mutation.read", "", wire.ComputerConnectorMutationRead{Execution: e, CallId: fmt.Sprintf("observe-%d", hours), OperationId: "original-write-operation", WorkspaceId: "work", RelativePath: "sentinel.txt"}), "completed")
		if !reflect.DeepEqual(retained.Origin, first.Origin) || !reflect.DeepEqual(retained.Receipt, first.Receipt) {
			t.Fatal("original result changed")
		}
		if !reflect.DeepEqual(root.publication.approval, originalApproval) || root.publication.receipt != *publication || s.current.opened.Endpoint.Binding != opened.Endpoint.Binding {
			t.Fatal("renewal replaced original identities")
		}
		if hours == 12 {
			edit := wire.ComputerConnectorEdit{Execution: e, CallId: "new-edit", WorkspaceId: "work", RelativePath: "sentinel.txt", ExpectedSHA256: first.Receipt.AfterSHA256, Edits: []wire.ComputerTextEdit{{OldText: "before", NewText: "after"}}}
			result := nativeMutationResult(t, p.call(t, "computer.workspace.edit", "new-edit-operation", edit), "completed")
			if result.Receipt.Replacements != 1 {
				t.Fatal("edit not applied once")
			}
		}
	}
	proofAfter := p.call(t, "computer.connector.verify", "", wire.ComputerConnectorVerify{Challenge: challenge, CallId: "observe-original-proof", WorkspaceId: "work"})
	var observed wire.ComputerConnectorVerificationState
	if proofAfter.Status != "ok" || json.Unmarshal(proofAfter.Data, &observed) != nil || !reflect.DeepEqual(observed, proofBefore) {
		t.Fatal("verification replayed or lost original proof")
	}
	if root.publication.refreshCount != 3 {
		t.Fatal("unexpected renewal count")
	}
	content, err := os.ReadFile(filepath.Join(workspace, "sentinel.txt"))
	if err != nil || string(content) != "after renewal\n" {
		t.Fatal("unexpected physical effects", err)
	}
	status, err := store.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeApproval(ctx, status.Revision); err != nil {
		t.Fatal(err)
	}
	if got := p.call(t, "computer.connector.verify", "", verify); got.Status == "ok" {
		t.Fatal("revoked consent revived")
	}
}

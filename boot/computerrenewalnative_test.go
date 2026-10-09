//go:build darwin

package boot

import (
	"bytes"
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
	base, err := os.MkdirTemp("/private/tmp", "farol-renewal-native-")
	if err != nil {
		t.Fatal(err)
	}
	baseInfo, err := os.Lstat(base)
	canonical, canonicalErr := filepath.EvalSymlinks(base)
	if err != nil || canonicalErr != nil || canonical != base || !baseInfo.IsDir() || baseInfo.Mode().Perm() != 0700 {
		t.Fatal("disposable root identity unavailable; retain", base)
	}
	var streamClosed, socketClosed, repositoryClosed, storeClosed bool
	// Registered first, so every original owner's cleanup must finish before
	// deletion. A failed test or unknown cleanup retains the fresh root as evidence.
	t.Cleanup(func() {
		if t.Failed() || !streamClosed || !socketClosed || !repositoryClosed || !storeClosed {
			t.Log("retained disposable renewal root", base)
			return
		}
		current, err := os.Lstat(base)
		canonical, canonicalErr := filepath.EvalSymlinks(base)
		if err != nil || canonicalErr != nil || canonical != base || !current.IsDir() || current.Mode().Perm() != 0700 || !os.SameFile(current, baseInfo) {
			t.Error("disposable root cleanup identity changed; retain", base)
			return
		}
		if err := os.RemoveAll(base); err != nil {
			t.Error("disposable root cleanup failed", err)
		}
	})
	// Each fresh allocation supplies a distinct namespace; no prior native roots,
	// host identities or operation IDs are selected by this fixture.
	id := func(name string) string { return name + "-" + filepath.Base(base) }
	profileID, ownerID, computerID, workspaceID := id("profile"), id("owner"), id("computer"), id("work")
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
	store, err := accessrepo.Create(state, accessrepo.Binding{ProfileID: profileID, OwnerID: ownerID, ComputerID: computerID}, clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
			return
		}
		storeClosed = true
	})
	fileOwners, err := newComputerFileOwners(home)
	if err != nil {
		t.Fatal(err)
	}
	root := &ComputerIngress{store: store, native: fileOwners, clock: clock, peer: wire.Context{ProfileId: profileID, BackendGeneration: id("backend")}, ownerID: ownerID, computerID: computerID, used: make(map[string]bool)}
	fence, err := root.Deactivate(ctx, id("withdraw-initial"))
	if err != nil {
		t.Fatal(err)
	}
	var ws, st unix.Stat_t
	if unix.Lstat(workspace, &ws) != nil || unix.Lstat(state, &st) != nil {
		t.Fatal("fixture physical identity unavailable")
	}
	raw, err := json.Marshal(map[string]any{"ownerId": ownerID, "computerId": computerID, "generation": 1,
		"workspaces":    []any{map[string]any{"workspaceId": workspaceID, "root": workspace, "access": "write", "rootIdentity": map[string]string{"device": fmt.Sprint(ws.Dev), "inode": fmt.Sprint(ws.Ino)}}},
		"excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read", "workspace.search", "workspace.write"}, "network": "none", "commands": "none", "filePolicy": "approved-roots-v1", "expiresAt": start.Add(authority.TaskGrantLifetime).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	renewable := true
	publication, err := root.Publish(ctx, id("original-owner-publication"), wire.ComputerAuthorityPublishRequest{Fence: fence.Fence, ExpectedStoreRevision: fence.StoreRevision, SettingsRevision: "1", Approval: raw, RenewableOwnerConsent: &renewable})
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
			return
		}
		repositoryClosed = true
	})
	s.mutations, err = settingsMutationIngress(root, computerMutationDependencies{repository: repo, native: fileOwners, digester: filesystem.Digester{}})
	if err != nil {
		t.Fatal(err)
	}
	challenge := id("disposable-renewal-challenge")
	digest := sha256.Sum256([]byte(challenge))
	challengeHash := hex.EncodeToString(digest[:])
	opened, err := s.Open(ctx, id("original-connector-open"), wire.ComputerConnectorOpen{Publication: *publication, RuntimeId: id("same-runtime"), ConnectorGeneration: "4", LaunchDigest: challengeHash, ChallengeSha256: &challengeHash})
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
			return
		}
		socketClosed = true
	})
	// Stop only the original slot's proactive poll. Its bounded done observation
	// precedes every modeled advance; connector and host-guard lifetime stay live.
	slot := s.current
	if slot == nil || slot.renewalCancel == nil || slot.renewalDone == nil {
		t.Fatal("original renewal poll unavailable")
	}
	slot.renewalCancel()
	pollStop := time.NewTimer(time.Second)
	defer pollStop.Stop()
	select {
	case <-slot.renewalDone:
	case <-pollStop.C:
		t.Fatal("original renewal poll stop unconfirmed")
	}
	stream, err := net.DialTimeout("unix", opened.Endpoint.SocketPath, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := stream.Close(); err != nil {
			t.Error(err)
			return
		}
		streamClosed = true
	})
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
	writeNativeMutationJSON(t, stream, wire.Request{Jsonrpc: "2.0", Id: id("hello"), Method: "core.handshake", Params: wire.Call{Body: hello}})
	data, err = ipc.ReadFrame(stream)
	var response wire.Response
	if err != nil || json.Unmarshal(data, &response) != nil || response.Result == nil || response.Result.Status != "ok" {
		t.Fatal("same socket handshake failed", err)
	}
	p := &nativeMutationPeer{stream: stream, opened: *opened}
	e := opened.Execution
	verify := wire.ComputerConnectorVerify{Challenge: challenge, CallId: id("original-verify"), WorkspaceId: workspaceID}
	proof := p.call(t, "computer.connector.verify", "", verify)
	if proof.Status != "ok" {
		t.Fatal("initial verify", proof.Status, proof.Code)
	}
	var proofBefore wire.ComputerConnectorVerificationState
	if json.Unmarshal(proof.Data, &proofBefore) != nil || proofBefore.Receipt == nil {
		t.Fatal("no original proof")
	}
	writeOperation := id("original-write-operation")
	write := wire.ComputerConnectorWrite{Execution: e, CallId: id("original-write"), WorkspaceId: workspaceID, RelativePath: "sentinel.txt", Content: "before renewal\n"}
	first := nativeMutationResult(t, p.call(t, "computer.workspace.write", writeOperation, write), "completed")
	originalApproval := root.publication.approval.Clone()
	for boundary, hours := range []int{12, 24, 72} {
		before, err := store.Status(ctx)
		if err != nil {
			t.Fatal(err)
		}
		refreshes := root.publication.refreshCount
		// +1 ms past original expiry; later advances also pass the last renewed
		// expiry strictly, rather than relying on exact-boundary equality.
		at := start.Add(time.Duration(hours) * time.Hour).Add(time.Duration(boundary+1) * time.Millisecond)
		if !at.After(root.publication.current().ExpiresAt) {
			t.Fatal("modeled boundary has not expired")
		}
		fileBefore, err := os.Lstat(filepath.Join(workspace, "sentinel.txt"))
		if err != nil {
			t.Fatal(err)
		}
		contentBefore, err := os.ReadFile(filepath.Join(workspace, "sentinel.txt"))
		if err != nil {
			t.Fatal(err)
		}
		clock.set(at)
		// FIRST request after advancing time: neither File nor Settings nor a
		// proactive tick can renew authority before this retained observation.
		retained := nativeMutationResult(t, p.call(t, "computer.workspace.mutation.read", "", wire.ComputerConnectorMutationRead{Execution: e, CallId: id(fmt.Sprintf("observe-%d", hours)), OperationId: writeOperation, WorkspaceId: workspaceID, RelativePath: "sentinel.txt"}), "completed")
		// Capture physical evidence immediately after the observation, before any
		// subsequent Store/File/Settings operation. These are lower-bound guards
		// against an atomic same-content rewrite, independent of the old receipt.
		fileAfter, err := os.Lstat(filepath.Join(workspace, "sentinel.txt"))
		content, readErr := os.ReadFile(filepath.Join(workspace, "sentinel.txt"))
		expected := "before renewal\n"
		if hours != 12 {
			expected = "after renewal\n"
		}
		if err != nil || readErr != nil || !os.SameFile(fileBefore, fileAfter) || fileBefore.Size() != fileAfter.Size() ||
			!fileBefore.ModTime().Equal(fileAfter.ModTime()) || !bytes.Equal(contentBefore, content) || string(content) != expected {
			t.Fatal("retained observation repeated or changed the write", hours, err, readErr)
		}
		after, err := store.Status(ctx)
		if err != nil || after.Revision != before.Revision+1 || root.publication.refreshCount != refreshes+1 ||
			!root.publication.current().ExpiresAt.Equal(at.Add(authority.TaskGrantLifetime)) {
			t.Fatal("first observation did not renew exactly once", hours, err)
		}
		if !reflect.DeepEqual(retained.Origin, first.Origin) || !reflect.DeepEqual(retained.Receipt, first.Receipt) || retained.Publication != first.Publication {
			t.Fatal("original result changed")
		}
		if s.current != slot || !reflect.DeepEqual(root.publication.approval, originalApproval) || root.publication.receipt != *publication ||
			slot.opened.Endpoint.Binding != opened.Endpoint.Binding || slot.opened.Execution != e {
			t.Fatal("renewal replaced original identities")
		}
		read := wire.ComputerReadRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: id(fmt.Sprintf("read-%d", hours)), WorkspaceId: workspaceID, RelativePath: "sentinel.txt"}
		if got := p.call(t, "computer.workspace.read", "", read); got.Status != "ok" {
			t.Fatal("read after modeled hours", hours, got.Status, got.Code)
		}
		if got, err := root.settingsSnapshot(ctx, wire.ComputerSettingsSnapshotRequest{Publication: *publication, WorkspaceId: workspaceID, RelativePath: "sentinel.txt"}); err != nil || got == nil {
			t.Fatal("current Settings", hours, err)
		}
		if root.publication.refreshCount != refreshes+1 || !reflect.DeepEqual(root.publication.approval, originalApproval) ||
			root.publication.receipt != *publication || slot.opened.Endpoint.Binding != opened.Endpoint.Binding {
			t.Fatal("subsequent reads renewed again or replaced original identities")
		}
		if hours == 12 {
			edit := wire.ComputerConnectorEdit{Execution: e, CallId: id("new-edit"), WorkspaceId: workspaceID, RelativePath: "sentinel.txt", ExpectedSHA256: first.Receipt.AfterSHA256, Edits: []wire.ComputerTextEdit{{OldText: "before", NewText: "after"}}}
			result := nativeMutationResult(t, p.call(t, "computer.workspace.edit", id("new-edit-operation"), edit), "completed")
			if result.Receipt.Replacements != 1 {
				t.Fatal("edit not applied once")
			}
		}
	}
	proofAfter := p.call(t, "computer.connector.verify", "", wire.ComputerConnectorVerify{Challenge: challenge, CallId: id("observe-original-proof"), WorkspaceId: workspaceID})
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
	if got := p.call(t, "computer.connector.verify", "", verify); got.Status != "refused" || got.Code == nil || *got.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || len(got.Data) != 0 {
		t.Fatal("revoked consent did not produce known refusal; retain", got.Status, got.Code)
	}
}

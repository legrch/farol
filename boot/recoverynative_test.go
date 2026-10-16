//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutation "github.com/legrch/farol/modules/computer/domain/mutation"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

// Actual native stores and filesystem. The old owner is closed without a clean
// handoff, with a real prepared/unknown journal record but no workspace effect.
// This does not establish process death, arbitrary descendant closure, Electron
// selection or permission to replay any old operation.
func recoveryNativeFixture(t *testing.T) (NativeLaunch, string, mutation.Binding) {
	t.Helper()
	launch, old := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "note.md"), []byte("retained native recovery text\n"), 0600); err != nil {
		t.Fatal(err)
	}
	nativeSettingsPublication(t, old, workspace, 1)
	binding := mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: "unknown-write", OwnerID: launch.OwnerID, ProfileID: launch.Profile.ProfileID, ComputerID: launch.ComputerID}, ComputerGeneration: 1, WorkspaceID: "00000000-0000-4000-8000-000000000004", RelativePath: "note.md", RequestDigest: strings.Repeat("a", 64)}
	prepared, err := mutation.NewPrepared(binding)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.mutationStore.Admit(context.Background(), prepared); err != nil {
		t.Fatal(err)
	}
	uncertain, err := prepared.Refuse(mutation.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
	if err != nil {
		t.Fatal(err)
	}
	if err = old.mutationStore.Save(context.Background(), uncertain); err != nil {
		t.Fatal(err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode, launch.StartupMode = "open", "recovery"
	launch.SettingsMutations = false
	launch.HostLifetimeID, launch.ChildLaunchID = "recovery-host", "recovery-child"
	return launch, workspace, binding
}

func recoverySnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, name := range []string{"chat", "task", filepath.Join("computer", "mutations")} {
		err := filepath.WalkDir(filepath.Join(root, name), func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			var physical unix.Stat_t
			if err := unix.Lstat(path, &physical); err != nil {
				return err
			}
			out[strings.TrimPrefix(path, root)] = fmt.Sprintf("%o:%d:%d:%d:%d:%v:%v:%s", info.Mode(), physical.Dev, physical.Ino, physical.Uid, physical.Nlink, physical.Mtim, physical.Ctim, data)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func recoveryCall(t *testing.T, r *NativeRecovery, name, operation string, body any) *desktop.Outcome {
	t.Helper()
	methods, err := r.Methods()
	if err != nil {
		t.Fatal(err)
	}
	method, ok := methods[name]
	if !ok {
		t.Fatal("method absent", name)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	out, err := method.Handle(context.Background(), desktop.Request{RequestID: "recovery-call", OperationID: operation, Body: raw})
	if err != nil || out == nil {
		t.Fatalf("%s: %#v %v", name, out, err)
	}
	return out
}

func recoveryPublish(t *testing.T, r *NativeRecovery, workspace string, generation int, search ...bool) wire.ComputerAuthorityPublication {
	t.Helper()
	var root unix.Stat_t
	if err := unix.Lstat(workspace, &root); err != nil {
		t.Fatal(err)
	}
	var fence wire.ComputerAuthorityDeactivateResponse
	out := recoveryCall(t, r, "computer.authority.deactivate", fmt.Sprint("withdraw-", generation), map[string]any{})
	if out.Status != "ok" || json.Unmarshal(out.Data, &fence) != nil {
		t.Fatalf("withdraw: %#v", out)
	}
	capabilities := []string{"workspace.list", "workspace.read", "workspace.write"}
	if len(search) == 1 && search[0] {
		capabilities = append(capabilities, "workspace.search")
	}
	approval, err := json.Marshal(map[string]any{"ownerId": "owner", "computerId": r.ingress.computerID, "generation": generation, "workspaces": []any{map[string]any{"workspaceId": "00000000-0000-4000-8000-000000000004", "root": workspace, "access": "write", "rootIdentity": map[string]string{"device": fmt.Sprint(root.Dev), "inode": fmt.Sprint(root.Ino)}}}, "excludedPaths": []any{}, "capabilities": capabilities, "network": "none", "commands": "none", "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	request := wire.ComputerAuthorityPublishRequest{Fence: fence.Fence, ExpectedStoreRevision: fence.StoreRevision, SettingsRevision: fmt.Sprint(generation), Approval: approval}
	out = recoveryCall(t, r, "computer.authority.publish", fmt.Sprint("publish-", generation), request)
	var publication wire.ComputerAuthorityPublication
	if out.Status != "ok" || json.Unmarshal(out.Data, &publication) != nil {
		t.Fatalf("publication: %#v", out)
	}
	return publication
}

func TestNativeRecoveryReadsRequireFreshPublicationAndPreserveUnknown(t *testing.T) {
	launch, workspace, binding := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	// A separate retained-mutation owner may keep its existing writer lock.
	// Recovery must neither open it nor turn its unknown record into a result.
	var root unix.Stat_t
	if err := unix.Lstat(filepath.Join(launch.Profile.Root, "computer"), &root); err != nil {
		t.Fatal(err)
	}
	journal, err := mutationrepo.New(context.Background(), mutationrepo.Root{Path: filepath.Join(launch.Profile.Root, "computer"), Device: uint64(root.Dev), Inode: root.Ino, OwnerUID: root.Uid})
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	r, err := NewNativeRecovery(context.Background(), launch, "recovery-generation")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	methods, err := r.Methods()
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for name := range methods {
		names = append(names, name)
	}
	slices.Sort(names)
	want := []string{"computer.authority.deactivate", "computer.authority.publish", "computer.settings.list", "computer.settings.search", "computer.settings.snapshot"}
	if !reflect.DeepEqual(names, want) {
		t.Fatal("unexpected recovery surface", names)
	}
	readers, ok := r.ingress.native.(*computerFileOwners)
	if !ok || readers.legacyMutation != nil || readers.rootMutation != nil || r.ingress.chat != nil || r.ingress.taskCurrentSource != nil {
		t.Fatal("recovery composed an effect owner")
	}
	request := wire.ComputerSettingsListRequest{Publication: wire.ComputerAuthorityPublication{Fence: "1", StoreRevision: "1", SettingsRevision: "1", Generation: "1", ApprovalDigest: strings.Repeat("a", 64), PublishOperationId: "old-publication"}, WorkspaceId: binding.WorkspaceID, RelativePath: "."}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	refused, err := methods["computer.settings.list"].Handle(context.Background(), desktop.Request{Body: raw})
	if refused != nil && refused.Status == "ok" {
		t.Fatal("disk/caller projection became a live publication")
	}
	if refused == nil && err == nil {
		t.Fatal("missing refusal evidence")
	}
	request.Publication = recoveryPublish(t, r, workspace, 1)
	out := recoveryCall(t, r, "computer.settings.list", "", request)
	var listed wire.ComputerSettingsListResponse
	if out.Status != "ok" || json.Unmarshal(out.Data, &listed) != nil || string(listed.Entries) != `["note.md"]` {
		t.Fatalf("native read: %#v", out)
	}
	snapshot := recoveryCall(t, r, "computer.settings.snapshot", "", wire.ComputerSettingsSnapshotRequest{Publication: request.Publication, WorkspaceId: binding.WorkspaceID, RelativePath: "note.md"})
	var metadata wire.ComputerSettingsSnapshotResponse
	original, err := os.ReadFile(filepath.Join(workspace, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(original)
	if snapshot.Status != "ok" || json.Unmarshal(snapshot.Data, &metadata) != nil || metadata.Sha256 != hex.EncodeToString(digest[:]) || int(metadata.Bytes) != len(original) {
		t.Fatalf("native snapshot: %#v", snapshot)
	}
	searched := recoveryCall(t, r, "computer.settings.search", "", wire.ComputerSettingsSearchRequest{Publication: request.Publication, WorkspaceId: binding.WorkspaceID, RelativePath: ".", Pattern: "retained"})
	if searched.Status != "refused" || searched.Code != "AUTHORITY_CAPABILITY_DENIED" {
		t.Fatalf("search escaped original missing capability: %#v", searched)
	}
	// Explicit synthetic owner approval advances generation and adds Search.
	// The old generation-1 UNKNOWN record still must not change or replay.
	request.Publication = recoveryPublish(t, r, workspace, 2, true)
	searched = recoveryCall(t, r, "computer.settings.search", "", wire.ComputerSettingsSearchRequest{Publication: request.Publication, WorkspaceId: binding.WorkspaceID, RelativePath: ".", Pattern: "retained"})
	var matches wire.ComputerSettingsSearchResponse
	if searched.Status != "ok" || json.Unmarshal(searched.Data, &matches) != nil || !strings.Contains(string(matches.Matches), "note.md") {
		t.Fatalf("native search: %#v", searched)
	}
	// Querying and publishing cannot admit a participant or resume old work.
	if len(r.ingress.tasks) != 0 || len(r.ingress.turns) != 0 {
		t.Fatal("recovery fabricated membership")
	}
	kept, err := journal.Load(context.Background(), binding.Identity)
	if err != nil || kept == nil || kept.Phase() != mutation.OutcomeUnknown {
		t.Fatal("unknown record changed", kept, err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, recoverySnapshot(t, launch.Profile.Root)) {
		t.Fatal("recovery changed Chat/Task/mutation bytes or modes")
	}
	// Even an incorrect fresh caller assertion cannot obtain normal startup.
	launch.StartupMode = "normal"
	launch.PreviousHostDrainConfirmed = true
	if normal, err := NewNativeRuntime(context.Background(), launch, "no-clean-successor"); normal != nil || err == nil {
		if normal != nil {
			normal.Close()
		}
		t.Fatal("recovery manufactured clean retirement")
	}
}

func TestNativeRecoveryCloseJoinsReadAndWithholdsResults(t *testing.T) {
	launch, workspace, _ := recoveryNativeFixture(t)
	r, err := NewNativeRecovery(context.Background(), launch, "recovery-generation")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	publication := recoveryPublish(t, r, workspace, 1)
	entered, release := make(chan struct{}), make(chan struct{})
	native := &settingsNativeFixture{after: func() { close(entered); <-release }}
	r.ingress.native = native
	methods, err := r.Methods()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(wire.ComputerSettingsListRequest{Publication: publication, WorkspaceId: "00000000-0000-4000-8000-000000000004", RelativePath: "."})
	result := make(chan error, 1)
	go func() {
		out, err := methods["computer.settings.list"].Handle(context.Background(), desktop.Request{Body: raw})
		if out != nil && out.Status == "ok" {
			result <- fmt.Errorf("closed reader disclosed a result")
		} else {
			result <- err
		}
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("read did not enter")
	}
	done := make(chan error, 1)
	go func() { done <- r.Close() }()
	for !r.closed.Load() {
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-done:
		t.Fatalf("closed before read return: %v", err)
	default:
	}
	if store, err := accessrepo.Open(filepath.Join(launch.Profile.Root, "computer"), accessrepo.Binding{ProfileID: launch.Profile.ProfileID, OwnerID: launch.OwnerID, ComputerID: launch.ComputerID}, accessrepo.Clock{}); err == nil {
		store.Close()
		t.Fatal("released authority claim before actual read return")
	}
	close(release)
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("cancelled read became success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("read retained after actual return")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not join")
	}
	if methods, err := r.Methods(); methods != nil || err == nil {
		t.Fatal("closed owner exposed methods")
	}
}

// Real CLI flag parsing and framed Go transport over owned pipes, with native
// profile/stores. No separate OS process, Electron or installed host is proved.
func TestNativeRecoveryCLIHasNoEffectOrTaskRoutes(t *testing.T) {
	launch, workspace, binding := recoveryNativeFixture(t)
	before := recoverySnapshot(t, launch.Profile.Root)
	input, sender := io.Pipe()
	receiver, output := io.Pipe()
	var diagnostics bytes.Buffer
	done := make(chan int, 1)
	args := []string{"serve", "--profile", launch.Profile.ProfileID, "--profile-root", launch.Profile.Root, "--profile-device", fmt.Sprint(launch.Profile.Device), "--profile-inode", fmt.Sprint(launch.Profile.Inode), "--owner", launch.OwnerID, "--computer", launch.ComputerID, "--home", launch.Home, "--store-mode", "open", "--startup-mode", "recovery", "--host-lifetime", launch.HostLifetimeID, "--child-launch", launch.ChildLaunchID}
	go func() { done <- Run(args, input, output, &diagnostics) }()
	finished := false
	finish := func() {
		if finished {
			return
		}
		finished = true
		sender.Close()
		receiver.Close()
		select {
		case code := <-done:
			if code != 0 {
				t.Errorf("recovery CLI terminal %d: %s", code, diagnostics.String())
			}
		case <-time.After(5 * time.Second):
			t.Error("recovery CLI terminal unknown; fixture preserved")
		}
	}
	defer finish()
	var peer *wire.Context
	sequence := 0
	invoke := func(method, operation string, body any) *wire.Outcome {
		t.Helper()
		sequence++
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := wire.Request{Jsonrpc: "2.0", Id: fmt.Sprint("recovery-", sequence), Method: method, Params: wire.Call{Context: peer, Body: raw}}
		if operation != "" {
			request.Params.OperationId = &operation
		}
		frame, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		type result struct {
			data []byte
			err  error
		}
		response := make(chan result, 1)
		go func() {
			if err := ipc.WriteFrame(sender, frame); err != nil {
				response <- result{err: err}
				return
			}
			data, err := ipc.ReadFrame(receiver)
			response <- result{data, err}
		}()
		select {
		case got := <-response:
			var reply wire.Response
			if got.err != nil || json.Unmarshal(got.data, &reply) != nil || reply.Error != nil || reply.Result == nil {
				t.Fatalf("framed recovery %s: %s %v", method, got.data, got.err)
			}
			return reply.Result
		case <-time.After(5 * time.Second):
			t.Fatalf("recovery %s response unknown; no replay", method)
		}
		return nil
	}
	hello := invoke("core.handshake", "", wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: BuildID, ProfileId: launch.Profile.ProfileID})
	var identity wire.Identity
	if hello.Status != "ok" || json.Unmarshal(hello.Data, &identity) != nil {
		t.Fatal("invalid recovery identity")
	}
	peer = &hello.Context
	expected := []string{"core.status", "computer.authority.deactivate", "computer.authority.publish", "computer.settings.list", "computer.settings.search", "computer.settings.snapshot"}
	if !reflect.DeepEqual(identity.Capabilities, expected) {
		t.Fatal("recovery advertised broader capabilities", identity.Capabilities)
	}
	var withdrawn wire.ComputerAuthorityDeactivateResponse
	if result := invoke("computer.authority.deactivate", "withdraw", map[string]any{}); result.Status != "ok" || json.Unmarshal(result.Data, &withdrawn) != nil {
		t.Fatal("withdraw failed", result)
	}
	var root unix.Stat_t
	if err := unix.Lstat(workspace, &root); err != nil {
		t.Fatal(err)
	}
	approval, _ := json.Marshal(map[string]any{"ownerId": launch.OwnerID, "computerId": launch.ComputerID, "generation": 1, "workspaces": []any{map[string]any{"workspaceId": binding.WorkspaceID, "root": workspace, "access": "write", "rootIdentity": map[string]string{"device": fmt.Sprint(root.Dev), "inode": fmt.Sprint(root.Ino)}}}, "excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read", "workspace.write"}, "network": "none", "commands": "none", "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
	var publication wire.ComputerAuthorityPublication
	if result := invoke("computer.authority.publish", "publish", wire.ComputerAuthorityPublishRequest{Fence: withdrawn.Fence, ExpectedStoreRevision: withdrawn.StoreRevision, SettingsRevision: "1", Approval: approval}); result.Status != "ok" || json.Unmarshal(result.Data, &publication) != nil {
		t.Fatal("publish failed", result)
	}
	for _, name := range []string{"computer.settings.delivery.apply", "computer.connector.open", "core.retirement.prepare", "chat.conversation.start", "task.model.resolve", "task.models.describe", "task.settings.compare", "computer.process.start", "computer.settings.store.next"} {
		if !wire.KnownMethod(name) {
			t.Fatal("invalid denial witness method", name)
		}
		operation := ""
		if wire.RequiresOperationID(name) {
			operation = binding.Identity.OperationID + fmt.Sprint("-", sequence)
		}
		denied := invoke(name, operation, map[string]any{})
		if denied.Status != "unavailable" || (denied.Code == nil || *denied.Code != "capability_unavailable") {
			t.Fatalf("effect route reachable: %s %#v", name, denied)
		}
	}
	if result := invoke("computer.settings.list", "", wire.ComputerSettingsListRequest{Publication: publication, WorkspaceId: binding.WorkspaceID, RelativePath: "."}); result.Status != "ok" {
		t.Fatal("known unavailable route disabled independent read", result)
	}
	finish()
	if !reflect.DeepEqual(before, recoverySnapshot(t, launch.Profile.Root)) {
		t.Fatal("CLI modified original unknown work")
	}
}

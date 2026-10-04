//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

// Actual normal NativeRuntime, native private journal and native exact-hash edit.
// The workspace/consent and host terminal/drain facts are fixtures. This is not
// an Electron/package/installed or real host retirement observation.
func nativeSettingsCall(t *testing.T, runtime *NativeRuntime, method, operation string, body any) *desktop.Outcome {
	t.Helper()
	methods, err := runtime.Methods()
	if err != nil {
		t.Fatal(err)
	}
	selected, exists := methods[method]
	if !exists {
		t.Fatalf("method absent: %s", method)
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	out, err := selected.Handle(context.Background(), desktop.Request{OperationID: operation, Body: raw})
	if err != nil || out == nil {
		t.Fatalf("%s: %v %#v", method, err, out)
	}
	return out
}
func nativeSettingsPublication(t *testing.T, runtime *NativeRuntime, workspace string, generation int) wire.ComputerAuthorityPublication {
	t.Helper()
	var stat unix.Stat_t
	if err := unix.Lstat(workspace, &stat); err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprint(generation)
	fence, err := runtime.ingress.Deactivate(context.Background(), "deactivate-"+prefix)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(map[string]any{"ownerId": "owner", "computerId": "computer", "generation": generation, "workspaces": []any{map[string]any{"workspaceId": "work", "root": workspace, "access": "write", "rootIdentity": map[string]string{"device": fmt.Sprint(stat.Dev), "inode": fmt.Sprint(stat.Ino)}}}, "excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read", "workspace.write"}, "network": "none", "commands": "none", "expiresAt": time.Now().Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	publication, err := runtime.ingress.Publish(context.Background(), "publish-"+prefix, wire.ComputerAuthorityPublishRequest{Fence: fence.Fence, ExpectedStoreRevision: fence.StoreRevision, SettingsRevision: prefix, Approval: raw})
	if err != nil {
		t.Fatal(err)
	}
	return *publication
}
func TestNativeSettingsMutationNormalRuntimeAndCleanRejoin(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(workspace, "note.md")
	const original = "one old fragment\n"
	if err := os.WriteFile(target, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	before, err := os.ReadFile(filepath.Join(launch.Profile.Root, "chat", "chat-lifecycle.json"))
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(original))
	request := wire.ComputerSettingsEditRequest{Publication: publication, WorkspaceId: "work", RelativePath: "note.md", ExpectedSHA256: hex.EncodeToString(hash[:]), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}}
	out := nativeSettingsCall(t, runtime, "computer.settings.edit", "native-edit", request)
	if out.Status != "ok" {
		t.Fatalf("edit: %#v", out)
	}
	var completed wire.ComputerSettingsMutationResponse
	if err := json.Unmarshal(out.Data, &completed); err != nil || completed.Phase != "completed" || completed.Publication != "durable" || completed.Receipt == nil {
		t.Fatalf("edit result: %s %v", out.Data, err)
	}
	after, err := os.ReadFile(target)
	if err != nil || string(after) != "one new fragment\n" {
		t.Fatal("native edit did not publish exact text", err)
	}
	mutatedHash := sha256.Sum256(after)
	if completed.Receipt.AfterSHA256 != hex.EncodeToString(mutatedHash[:]) || completed.Receipt.BeforeSHA256 == nil || *completed.Receipt.BeforeSHA256 != request.ExpectedSHA256 {
		t.Fatal("receipt not actual bytes")
	}
	afterChat, err := os.ReadFile(filepath.Join(launch.Profile.Root, "chat", "chat-lifecycle.json"))
	if err != nil || string(before) != string(afterChat) || len(runtime.ingress.tasks) != 0 || len(runtime.ingress.turns) != 0 {
		t.Fatal("Settings created synthetic Chat/Task authority")
	}
	conflict := request
	conflict.ExpectedSHA256 = strings.Repeat("0", 64)
	refused := nativeSettingsCall(t, runtime, "computer.settings.edit", "native-conflict", conflict)
	var failed wire.ComputerSettingsMutationResponse
	if refused.Status != "ok" || json.Unmarshal(refused.Data, &failed) != nil || failed.Phase != "failed" || failed.Publication != "durable" {
		t.Fatalf("hash conflict not retained: %#v %s", refused, refused.Data)
	}
	// Exact mutation root survived actual retirement and a distinct backend owner.
	terminal := preparedTerminal(t, runtime)
	if err := recordNativeTerminal(context.Background(), launch.Profile, terminal, func(wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode = "open"
	launch.HostLifetimeID, launch.ChildLaunchID = "host-2", "child-2"
	launch.PreviousHostDrainConfirmed = true
	next, err := NewNativeRuntime(context.Background(), launch, "generation-2")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := next.Close(); err != nil {
			t.Error(err)
		}
	})
	read := wire.ComputerSettingsMutationRead{OperationId: "native-edit", WorkspaceId: "work", RelativePath: "note.md", ComputerGeneration: "1"}
	observed := nativeSettingsCall(t, next, "computer.settings.mutation.read", "", read)
	if observed.Status != "ok" || string(observed.Data) != string(out.Data) {
		t.Fatalf("exact retained result lost: %#v %s", observed, observed.Data)
	}
	read.RelativePath = "other.md"
	if observed := nativeSettingsCall(t, next, "computer.settings.mutation.read", "", read); observed.Status == "ok" {
		t.Fatal("crossed path rejoined")
	}
	request.Publication = nativeSettingsPublication(t, next, workspace, 2)
	replay := nativeSettingsCall(t, next, "computer.settings.edit", "native-edit", request)
	if replay.Status == "ok" {
		t.Fatalf("changed generation re-admitted original: %s", replay.Data)
	}
	unchanged, err := os.ReadFile(target)
	if err != nil || string(unchanged) != string(after) {
		t.Fatal("replay mutated target", err)
	}
	records, err := os.ReadDir(filepath.Join(launch.Profile.Root, "computer", "mutations"))
	if err != nil || len(records) != 2 {
		t.Fatal("unexpected mutation publications", err, len(records))
	}
}
func TestNativeSettingsMutationUnknownBlocksRetirement(t *testing.T) {
	for _, stage := range []string{"pending", "unknown", "memory_only"} {
		t.Run(stage, func(t *testing.T) {
			_, runtime := retirementStorageFixture(t, true)
			runtime.mutations.operations["uncertain"] = &settingsMutationOperation{pending: stage == "pending", settled: false}
			out := retirementCall(t, runtime, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "handoff-uncertain"})
			if out.Status != "unknown" || runtime.retirement.publication != nil {
				t.Fatal("uncertain mutation licensed successor", out)
			}
			head, err := runtime.retirement.repo.Load(context.Background())
			if err != nil || head.Record != nil {
				t.Fatal("retirement publication preceded mutation gate", err)
			}
		})
	}
}

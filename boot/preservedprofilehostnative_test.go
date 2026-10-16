//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"golang.org/x/sys/unix"
)

// Actual built observation/preparation/terminal children, host filesystem and
// native cold Go/File runtime. Settings, desktop process history and browser
// remain declared synthetic fixtures; no Electron/provider/installed acceptance.
// Every fixture, including a failed or unknown host attempt, stays retained.
func TestNativePreservedProfileHostWithBuiltCore(t *testing.T) {
	if !*ingressNative || !*preservedProfileNative {
		t.Skip("requires exclusive built-core lane, -ingress-native and -preserved-profile-native")
	}
	repo, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema  int
		BuildID string
	}
	raw, err := os.ReadFile(filepath.Join(repo, "_output/build/app/build-manifest.json"))
	if err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Schema != 4 || len(manifest.BuildID) != 64 {
		t.Fatal("exact Go-enabled build prerequisite missing", err)
	}
	originalBuild := BuildID
	BuildID = manifest.BuildID
	defer func() { BuildID = originalBuild }()
	for _, previous := range []bool{false, true} {
		t.Run(fmt.Sprintf("previous-quit-%t", previous), func(t *testing.T) {
			temp := filepath.Join(repo, "_output/tmp")
			if err := os.MkdirAll(temp, 0700); err != nil {
				t.Fatal(err)
			}
			base, err := os.MkdirTemp(temp, "retirement-boot-")
			if err != nil {
				t.Fatal(err)
			}
			in, workspace := preservedProfileFixtureAt(t, base, true)
			state := filepath.Dir(in.Profile.Root)
			userData := filepath.Dir(state)
			connector := filepath.Join(state, "secure-mcp-connector", "computer-authority")
			if err := os.MkdirAll(filepath.Join(connector, "mcp-lifecycle"), 0700); err != nil {
				t.Fatal(err)
			}
			run := []byte("{\"schema\":1,\"pid\":2147483647,\"startedAt\":\"2026-10-08T09:44:38.119Z\",\"bootTime\":null,\"processStart\":null}\n")
			ready := map[string]any{"visited": false, "skipped": false, "configured": false, "reachable": "unknown", "verified": nil, "needsAction": nil, "unavailable": nil, "outcomeUnknown": false}
			config, err := json.Marshal(map[string]any{"schema": 1, "revision": 1, "general": map[string]any{"openAtLaunch": "home", "sidebarDefault": "full", "activityDetail": "summary"}, "computer": map[string]any{"computerId": in.ComputerID, "generation": 1, "name": "Synthetic", "commands": "none", "workspaces": []any{}, "pendingEdit": nil}, "setup": map[string]any{"chatgpt": ready, "computer": ready, "connect": ready, "hosts": ready, "verify": ready}})
			if err != nil {
				t.Fatal(err)
			}
			quit := []byte("{\"schema\":1,\"at\":\"2026-10-08T10:00:14.146Z\",\"drained\":false,\"unconfirmed\":[\"go-core\",\"connector\"]}\n")
			if previous {
				quit = []byte("{\"schema\":1,\"at\":\"2026-10-08T09:39:05.070Z\",\"drained\":true,\"unconfirmed\":[]}\n")
			}
			for name, value := range map[string][]byte{"running.json": run, "config.json": config, "last-quit.json": quit} {
				if err := os.WriteFile(filepath.Join(state, name), value, 0600); err != nil {
					t.Fatal(err)
				}
			}
			beforeWorkspace := snapshotPreservedObservationTree(t, workspace)
			beforeArchive := snapshotPreservedObservationTree(t, filepath.Join(in.Profile.Root, "chat"))
			profile := in.Profile
			in.Profile = ProfileBinding{}
			in.Selection.HandoffDigest, in.Selection.LifecycleDigest, in.Selection.ResultsDigest = [32]byte{}, [32]byte{}, [32]byte{}
			fixture := struct {
				Input                                                       preservedProfileInspectionInput
				Profile                                                     ProfileBinding
				ExpectedRunSha256, ExpectedConfigSha256, ExpectedQuitSha256 string
				PreservedProfile, PreviousConfirmedQuit                     bool
			}{in, profile, hex.EncodeToString(sumFixture(run)), hex.EncodeToString(sumFixture(config)), hex.EncodeToString(sumFixture(quit)), true, previous}
			raw, err := json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			inputPath := filepath.Join(userData, "host-qualification.json")
			if err := os.WriteFile(inputPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
			defer cancel()
			node, err := exec.LookPath("node")
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(ctx, node, filepath.Join(repo, "tests/e2e/closed-empty-chat-host.e2e.mjs"), inputPath)
			cmd.Dir = repo
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("original preserved host failed; retain %s: %v %s", userData, err, out)
			}
			var result struct {
				Phase string `json:"phase"`
			}
			if json.Unmarshal(out, &result) != nil || result.Phase != "prepared_for_cold_start" {
				t.Fatal("missing original host result")
			}
			archive := filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID)
			receipt, err := os.ReadFile(filepath.Join(archive, "maintenance-completed.json"))
			var completed struct {
				Schema            string
				RecorderConfirmed bool
				PreservedHistory  struct{ OriginalACK, OriginalTerminal string }
			}
			if err != nil || json.Unmarshal(receipt, &completed) != nil || completed.Schema != "farol.closed-preserved-chat-recovery/1" || !completed.RecorderConfirmed || completed.PreservedHistory.OriginalACK != "unobserved" || completed.PreservedHistory.OriginalTerminal != "unobserved" {
				t.Fatal("old historical facts upgraded", err)
			}
			for _, name := range []string{"running.json", "last-quit.json", "go-core.empty-recovery.pending"} {
				if _, err := os.Lstat(filepath.Join(state, name)); !os.IsNotExist(err) {
					t.Fatal("live obligation not retained away", name, err)
				}
			}
			if retained, err := os.ReadFile(filepath.Join(state, "config.json")); err != nil || string(retained) != string(config) {
				t.Fatal("config changed", err)
			}
			for name, expected := range map[string][]byte{"failed-running.json": run, "maintenance-intent.json": nil} {
				retained, err := os.ReadFile(filepath.Join(archive, name))
				if err != nil || expected != nil && string(retained) != string(expected) {
					t.Fatal("original host custody missing", name, err)
				}
			}
			quitName := "failed-last-quit.json"
			if previous {
				quitName = "previous-last-quit.json"
			}
			if retained, err := os.ReadFile(filepath.Join(archive, quitName)); err != nil || string(retained) != string(quit) {
				t.Fatal("original quit lost", err)
			}
			// All old files retain original bytes/identity after the known root
			// rename; only host-owned completion/marker/intent files were added.
			for oldPath, version := range beforeArchive.versions {
				rel, err := filepath.Rel(filepath.Join(profile.Root, "chat"), oldPath)
				if err != nil {
					t.Fatal(err)
				}
				if rel == "." {
					continue
				}
				var current = version
				if err := unix.Lstat(filepath.Join(archive, rel), &current); err != nil || !sameEmptyRecoveryStat(version, current) {
					t.Fatal("old archive physical version changed", rel, err)
				}
				if expected, ok := beforeArchive.bytes[oldPath]; ok {
					raw, err := os.ReadFile(filepath.Join(archive, rel))
					digest := sha256.Sum256(raw)
					if err != nil || hex.EncodeToString(digest[:]) != expected {
						t.Fatal("old archive bytes changed", rel, err)
					}
				}
			}
			unchangedPreservedObservationTree(t, workspace, beforeWorkspace)
			retainedArchive := snapshotPreservedObservationTree(t, archive)
			launch := NativeLaunch{Profile: profile, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Home: base, StoreMode: "open", SettingsMutations: true, HostLifetimeID: "qualified-preserved-cold-host", ChildLaunchID: "qualified-preserved-cold-child", PreviousHostDrainConfirmed: true}
			next, err := NewNativeRuntime(ctx, launch, "qualified-preserved-cold")
			if err != nil {
				t.Fatal("new real terminal handoff did not admit cold Go", err)
			}
			defer next.Close()
			next.settingsDelivery.store = &deliveryStoreFixture{value: delivery.Snapshot{Revision: 1, Current: delivery.Identity{ProfileID: profile.ProfileID, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Generation: 1}}}
			publication := nativeSettingsPublication(t, next, workspace, 1)
			before, err := os.ReadFile(filepath.Join(workspace, "note.md"))
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(before)
			request := wire.ComputerSettingsEditRequest{Publication: publication, WorkspaceId: "00000000-0000-4000-8000-000000000004", RelativePath: "note.md", ExpectedSHA256: hex.EncodeToString(digest[:]), Edits: []wire.ComputerTextEdit{{OldText: "new", NewText: "recovered"}}}
			response := nativeSettingsCall(t, next, "computer.settings.delivery.apply", freshEmptyRecoveryFixtureUUID(t), wire.SettingsDeliveryApply{DeadlineMillis: fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli()), Request: request})
			var offered wire.SettingsDeliveryResult
			if response.Status != "ok" || json.Unmarshal(response.Data, &offered) != nil || offered.Result == nil || offered.Result.Phase != "completed" || offered.ReceiptId == nil {
				t.Fatal("fresh writable File unavailable", response.Status)
			}
			if nativeSettingsCall(t, next, "computer.settings.delivery.ack", freshEmptyRecoveryFixtureUUID(t), wire.SettingsDeliveryACK{DeadlineMillis: fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli()), ReceiptId: *offered.ReceiptId, Pending: offered.Pending}).Status != "ok" {
				t.Fatal("fresh File ACK unavailable")
			}
			if raw, err := os.ReadFile(filepath.Join(workspace, "note.md")); err != nil || string(raw) != "one recovered fragment\n" {
				t.Fatal("fresh File effect missing", err)
			}
			peer := &retainedNativePeer{t: t, runtime: next}
			chatInput := chatport.ConversationInput{Binding: chatport.TurnBinding{ProfileID: profile.ProfileID, BackendGeneration: "qualified-preserved-cold", OwnerID: in.OwnerID, SessionID: "cold-session", TaskID: "cold-task", TaskEpoch: 1, ParticipantID: "cold-participant", OperationID: freshEmptyRecoveryFixtureUUID(t), TurnID: freshEmptyRecoveryFixtureUUID(t), TurnGeneration: 1}, Selection: chatport.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "controlled-account", ModelID: "controlled-model", Effort: "low"}, Required: chatport.RequiredControls{Model: true}, Prompt: "Synthetic fresh recovered Chat"}
			conversation, err := next.chat.CreateConversation(ctx, chatInput)
			if err != nil {
				t.Fatal("fresh Chat unavailable", err)
			}
			peer.run(func(d uint64) error { _, err := next.chat.PrepareNext(ctx, d); return err }, "prepare")
			peer.run(func(d uint64) error { return conversation.Send(ctx, d) }, "verify-send", "send")
			for _, kind := range []string{"accepted", "answer-delta", "completed"} {
				peer.run(func(d uint64) error { return conversation.Observe(ctx, d) }, kind)
			}
			answer, err := conversation.Result(ctx)
			if err != nil || !answer.Complete {
				t.Fatal("fresh Chat result unavailable", err)
			}
			if err := conversation.Acknowledge(ctx, answer.ResultID); err != nil {
				t.Fatal(err)
			}
			peer.run(func(d uint64) error { return conversation.Observe(ctx, d) }, "quiescent")
			if peer.sends != 1 {
				t.Fatal("fresh Chat unexpectedly repeated Send")
			}
			unchangedPreservedObservationTree(t, archive, retainedArchive)
			if err := next.Close(); err != nil {
				t.Fatal(err)
			}
			t.Logf("retained built host fixture %s, completion SHA256 %x; fresh writable Go File/Chat; original UNKNOWN/archive intact", userData, sha256.Sum256(receipt))
		})
	}
}

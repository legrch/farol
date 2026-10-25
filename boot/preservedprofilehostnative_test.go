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
	"reflect"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
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
	for _, scenario := range []struct {
		name                  string
		previousConfirmedQuit bool
		startupEmptyHistory   bool
		startupRetiredHistory bool
		quitAbsent            bool
		activeInstance        bool
		unsafeInstance        bool
		heldLifetime          bool
		unsettledMutation     string
		refusalCode           string
	}{
		{name: "startup-consumed-empty-three-incarnations", startupEmptyHistory: true},
		{name: "startup-retired-empty-thirty-three-incarnations", startupEmptyHistory: true, startupRetiredHistory: true, previousConfirmedQuit: true, refusalCode: "preserved_inspection_unconfirmed"},
		{name: "previous-quit-false"},
		{name: "previous-quit-true", previousConfirmedQuit: true},
		{name: "quit-absent", quitAbsent: true},
		{name: "quit-absent-active-instance", quitAbsent: true, activeInstance: true},
		{name: "quit-absent-unsafe-instance", quitAbsent: true, activeInstance: true, unsafeInstance: true, refusalCode: "COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE"},
		{name: "quit-absent-held-instance", quitAbsent: true, activeInstance: true, heldLifetime: true, refusalCode: "COMPUTER_MCP_LIFECYCLE_UNVERIFIED"},
		{name: "quit-absent-prepared-mutation", quitAbsent: true, activeInstance: true, unsettledMutation: "prepared", refusalCode: "CLOSED_COMPUTER_RECOVERY_WORK_PENDING"},
		{name: "quit-absent-unknown-mutation", quitAbsent: true, activeInstance: true, unsettledMutation: "outcome_unknown", refusalCode: "CLOSED_COMPUTER_RECOVERY_WORK_PENDING"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			temp := filepath.Join(repo, "_output/tmp")
			if err := os.MkdirAll(temp, 0700); err != nil {
				t.Fatal(err)
			}
			base, err := os.MkdirTemp(temp, "retirement-boot-")
			if err != nil {
				t.Fatal(err)
			}
			var in preservedProfileInspectionInput
			var workspace string
			if scenario.startupEmptyHistory {
				if scenario.startupRetiredHistory {
					in = preservedEmptyHistoryProfileFixture(t, 33, true)
				} else {
					in = preservedEmptyProfileFixture(t)
				}
				base = filepath.Dir(filepath.Dir(filepath.Dir(in.Profile.Root)))
				workspace = filepath.Join(base, "workspace")
				if err := os.Mkdir(workspace, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(workspace, "note.md"), []byte("one new fragment\n"), 0600); err != nil {
					t.Fatal(err)
				}
				metadata, err := json.Marshal(map[string]any{"schema": "farol-native-profile/2", "profileId": in.Profile.ProfileID, "computerId": in.ComputerID})
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(in.Profile.Root, "profile.json"), metadata, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				in, workspace = preservedProfileFixtureAt(t, base, true)
			}
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
			files := map[string][]byte{"running.json": run, "config.json": config}
			var quit []byte
			expectedQuitSha256 := ""
			if !scenario.quitAbsent {
				quit = []byte("{\"schema\":1,\"at\":\"2026-10-08T10:00:14.146Z\",\"drained\":false,\"unconfirmed\":[\"connector\",\"go-core\"]}\n")
				if scenario.previousConfirmedQuit {
					quit = []byte("{\"schema\":1,\"at\":\"2026-10-08T09:39:05.070Z\",\"drained\":true,\"unconfirmed\":[]}\n")
				}
				files["last-quit.json"] = quit
				expectedQuitSha256 = hex.EncodeToString(sumFixture(quit))
			}
			for name, value := range files {
				if err := os.WriteFile(filepath.Join(state, name), value, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario.quitAbsent {
				if _, err := os.Lstat(filepath.Join(state, "last-quit.json")); !os.IsNotExist(err) {
					t.Fatal("quit-absent fixture has a Quit", err)
				}
			}
			mutationDirectory := filepath.Join(connector, "mutations")
			var mutationsBefore preservedObservationTree
			if scenario.unsettledMutation != "" {
				// Valid connector-owned records in its separate native namespace.
				// These synthetic uncertain effects are never executed or replayed.
				operation := freshEmptyRecoveryFixtureUUID(t)
				owner, session, task, participant := "synthetic-owner", "connector-session", "connector-task", "connector-participant"
				key, err := json.Marshal([]any{operation, owner, session, task, 1, participant})
				if err != nil {
					t.Fatal(err)
				}
				var outcome any
				if scenario.unsettledMutation == "outcome_unknown" {
					outcome = map[string]any{"code": "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "source": "native-workspace"}
				}
				record := map[string]any{
					"identity":    map[string]any{"operationId": operation, "ownerId": owner, "sessionId": session, "taskId": task, "taskEpoch": 1, "participantId": participant},
					"workspaceId": "quarantined-connector-workspace", "requestDigest": strings.Repeat("a", 64), "phase": scenario.unsettledMutation, "outcome": outcome,
				}
				encoded, err := json.Marshal(map[string]any{"schemaVersion": 1, "kind": "workspace_mutation", "record": record})
				if err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(mutationDirectory, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(mutationDirectory, fmt.Sprintf("%x.json", sha256.Sum256(key))), append(encoded, '\n'), 0600); err != nil {
					t.Fatal(err)
				}
				mutationsBefore = snapshotPreservedObservationTree(t, mutationDirectory)
			}
			beforeWorkspace := snapshotPreservedObservationTree(t, workspace)
			beforeArchive := snapshotPreservedObservationTree(t, filepath.Join(in.Profile.Root, "chat"))
			var refusedProfile, refusedRun, refusedConfig, refusedMarker preservedObservationTree
			activeMarker := ""
			if scenario.activeInstance {
				// Real private marker bytes, with no MCP process. A separate case
				// retains an actual native shared lifetime claim during the host.
				activeMarker = filepath.Join(connector, "mcp-lifecycle", "active-"+freshEmptyRecoveryFixtureUUID(t))
				if err := os.WriteFile(activeMarker, []byte("1\n"), 0600); err != nil {
					t.Fatal(err)
				}
				if scenario.unsafeInstance {
					if err := os.Chmod(activeMarker, 0644); err != nil {
						t.Fatal(err)
					}
				}
				if scenario.heldLifetime {
					fd, err := unix.Open(filepath.Join(connector, "mcp-lifecycle", "lifetime.lock"), unix.O_RDWR|unix.O_CREAT|unix.O_NONBLOCK|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_SHLOCK, 0600)
					if err != nil {
						t.Fatal(err)
					}
					defer func() {
						if err := unix.Close(fd); err != nil {
							t.Error("owned MCP lifetime release unconfirmed", err)
						}
					}()
				}
				refusedProfile = snapshotPreservedObservationTree(t, in.Profile.Root)
				refusedRun = snapshotPreservedObservationTree(t, filepath.Join(state, "running.json"))
				refusedConfig = snapshotPreservedObservationTree(t, filepath.Join(state, "config.json"))
				refusedMarker = snapshotPreservedObservationTree(t, activeMarker)
			}
			if scenario.startupRetiredHistory {
				refusedProfile = snapshotPreservedObservationTree(t, in.Profile.Root)
				refusedRun = snapshotPreservedObservationTree(t, filepath.Join(state, "running.json"))
				refusedConfig = snapshotPreservedObservationTree(t, filepath.Join(state, "config.json"))
			}
			if in.Mutations == nil {
				in.Mutations = []mutationrepo.ExpectedOwnerRecord{}
			}
			profile := in.Profile
			in.Profile = ProfileBinding{}
			in.Selection.HandoffDigest, in.Selection.LifecycleDigest, in.Selection.ResultsDigest = [32]byte{}, [32]byte{}, [32]byte{}
			fixture := struct {
				Input                                   preservedProfileInspectionInput
				Profile                                 ProfileBinding
				ExpectedRunSha256, ExpectedConfigSha256 string
				ExpectedQuitSha256                      string `json:",omitempty"`
				PreservedProfile, PreviousConfirmedQuit bool
				QuitAbsent                              bool `json:",omitempty"`
				StartupMaintenance                      bool `json:",omitempty"`
			}{
				Input: in, Profile: profile,
				ExpectedRunSha256: hex.EncodeToString(sumFixture(run)), ExpectedConfigSha256: hex.EncodeToString(sumFixture(config)),
				ExpectedQuitSha256: expectedQuitSha256, PreservedProfile: true,
				PreviousConfirmedQuit: scenario.previousConfirmedQuit, QuitAbsent: scenario.quitAbsent, StartupMaintenance: scenario.startupEmptyHistory,
			}
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
			archive := filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID)
			if scenario.refusalCode != "" {
				exit, exited := err.(*exec.ExitError)
				if !exited || exit.ExitCode() <= 0 || ctx.Err() != nil || !strings.Contains(string(out), scenario.refusalCode) {
					t.Fatalf("original host did not return the selected refusal; retain %s: %v %s", userData, err, out)
				}
				absent := []string{archive, filepath.Join(state, "go-core.empty-recovery.pending")}
				if scenario.quitAbsent {
					absent = append(absent, filepath.Join(state, "last-quit.json"))
				} else {
					kept, readErr := os.ReadFile(filepath.Join(state, "last-quit.json"))
					if readErr != nil || string(kept) != string(quit) {
						t.Fatal("refusal changed original Quit", readErr)
					}
				}
				for _, path := range absent {
					if _, err := os.Lstat(path); !os.IsNotExist(err) {
						t.Fatal("refused recovery created archive, pending or Quit", path, err)
					}
				}
				unchangedPreservedObservationTree(t, profile.Root, refusedProfile)
				unchangedPreservedObservationTree(t, filepath.Join(state, "running.json"), refusedRun)
				unchangedPreservedObservationTree(t, filepath.Join(state, "config.json"), refusedConfig)
				if activeMarker != "" {
					unchangedPreservedObservationTree(t, activeMarker, refusedMarker)
				}
				unchangedPreservedObservationTree(t, workspace, beforeWorkspace)
				if scenario.unsettledMutation != "" {
					unchangedPreservedObservationTree(t, mutationDirectory, mutationsBefore)
				}
				entries, err := os.ReadDir(filepath.Join(connector, "mcp-lifecycle"))
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					if strings.HasPrefix(entry.Name(), "retired-") || strings.HasPrefix(entry.Name(), "reconciling-") {
						t.Fatal("refused instance acquired reconciliation authority", entry.Name())
					}
				}
				t.Logf("retained refused built host fixture %s; original run/config/Chat/UNKNOWN/workspace unchanged, no replay", userData)
				return
			}
			if err != nil {
				t.Fatalf("original preserved host failed; retain %s: %v %s", userData, err, out)
			}
			var result struct {
				Phase                string `json:"phase"`
				Archive, OperationID string
				Selected             struct{ OperationID, BackendGeneration, HostLifetimeID, ChildLaunchID string }
			}
			if json.Unmarshal(out, &result) != nil || result.Phase != "prepared_for_cold_start" {
				t.Fatal("missing original host result")
			}
			if scenario.startupEmptyHistory {
				if result.OperationID != result.Selected.OperationID || result.Selected.BackendGeneration == in.Selection.Current.Scope.BackendGeneration || result.Selected.HostLifetimeID == "" || result.Selected.ChildLaunchID == "" {
					t.Fatal("startup did not retain its own fresh exact selection")
				}
				in.Selection.OperationID, in.Selection.Next.BackendGeneration = result.Selected.OperationID, result.Selected.BackendGeneration
				in.Selection.HostLifetimeID, in.Selection.ChildLaunchID = result.Selected.HostLifetimeID, result.Selected.ChildLaunchID
				archive = filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID)
				if result.Archive != archive {
					t.Fatal("startup completion crossed selected archive")
				}
			}
			receipt, err := os.ReadFile(filepath.Join(archive, "maintenance-completed.json"))
			var completed struct {
				Schema                string
				RecorderConfirmed     bool
				OriginalQuitScope     string
				RetainedQuitSha256    json.RawMessage
				Publication           chatport.HandoffPublication
				Acknowledgement       wire.CoreRetirementAcknowledged
				OriginalChildTerminal wire.CoreTerminalObservation
				PreservedHistory      struct{ OriginalACK, OriginalTerminal string }
			}
			if err != nil || json.Unmarshal(receipt, &completed) != nil || completed.Schema != "farol.closed-preserved-chat-recovery/1" || !completed.RecorderConfirmed || completed.PreservedHistory.OriginalACK != "unobserved" || completed.PreservedHistory.OriginalTerminal != "unobserved" {
				t.Fatal("old historical facts upgraded", err)
			}
			maintenance := completed.Publication
			binding := maintenance.Binding
			if maintenance.HandoffID != in.Selection.OperationID || maintenance.ReceiptDigest == ([32]byte{}) || binding.ProfileID != profile.ProfileID || binding.BuildID != BuildID || binding.BackendGeneration != in.Selection.Next.BackendGeneration || binding.HostLifetimeID != in.Selection.HostLifetimeID || binding.ChildLaunchID != in.Selection.ChildLaunchID || binding.ParentRoot != in.Selection.Current.ParentRoot || binding.ChatRoot == in.Selection.Current.ChatRoot {
				t.Fatal("maintenance publication crossed selected identity")
			}
			var fresh unix.Stat_t
			if err := unix.Lstat(filepath.Join(profile.Root, "chat"), &fresh); err != nil || binding.ChatRoot != (chatport.JournalRoot{Device: uint64(fresh.Dev), Inode: fresh.Ino, OwnerUID: fresh.Uid}) {
				t.Fatal("maintenance publication did not name actual fresh Chat root", err)
			}
			ack := completed.Acknowledgement
			if ack.HandoffId != maintenance.HandoffID || ack.ReceiptDigest != hex.EncodeToString(maintenance.ReceiptDigest[:]) || len(ack.AckDigest) != 64 {
				t.Fatal("maintenance ACK did not correlate exact publication")
			}
			terminal := wire.CoreTerminalObservation{HandoffId: ack.HandoffId, ReceiptDigest: ack.ReceiptDigest, AckDigest: ack.AckDigest, BackendGeneration: in.Selection.Next.BackendGeneration, HostLifetimeId: in.Selection.HostLifetimeID, ChildLaunchId: in.Selection.ChildLaunchID, ExitCode: "0"}
			if completed.OriginalChildTerminal != terminal {
				t.Fatal("maintenance child terminal did not correlate exact ACK and clean exit")
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
			if scenario.quitAbsent {
				if completed.OriginalQuitScope != "absent" || len(completed.RetainedQuitSha256) != 0 {
					t.Fatal("absent original Quit was fabricated in completion")
				}
				for _, name := range []string{"last-quit.json", "failed-last-quit.json", "previous-last-quit.json"} {
					if _, err := os.Lstat(filepath.Join(archive, name)); !os.IsNotExist(err) {
						t.Fatal("quit-absent recovery fabricated retained Quit", name, err)
					}
				}
			} else {
				quitName := "failed-last-quit.json"
				if scenario.previousConfirmedQuit {
					quitName = "previous-last-quit.json"
				}
				if retained, err := os.ReadFile(filepath.Join(archive, quitName)); err != nil || string(retained) != string(quit) {
					t.Fatal("original quit lost", err)
				}
			}
			if scenario.quitAbsent {
				lifecycle := filepath.Join(connector, "mcp-lifecycle")
				retired := filepath.Join(lifecycle, "retired-"+in.Selection.OperationID)
				instances := []any{}
				if scenario.activeInstance {
					instances = append(instances, filepath.Base(activeMarker))
					if _, err := os.Lstat(activeMarker); !os.IsNotExist(err) {
						t.Fatal("inactive marker retained in active namespace", err)
					}
					var current unix.Stat_t
					target := filepath.Join(retired, filepath.Base(activeMarker))
					before := refusedMarker.versions[activeMarker]
					// Relocating this file may change ctime. Its identity, owner,
					// mode, link count, original mtime and bytes must remain exact.
					if err := unix.Lstat(target, &current); err != nil || current.Dev != before.Dev || current.Ino != before.Ino || current.Uid != before.Uid || current.Gid != before.Gid || current.Mode != before.Mode || current.Nlink != before.Nlink || current.Size != before.Size || current.Mtim != before.Mtim {
						t.Fatal("inactive marker physical custody changed", err)
					}
					retained, err := os.ReadFile(target)
					if err != nil || string(retained) != "1\n" {
						t.Fatal("inactive marker bytes changed", err)
					}
				}
				for _, name := range []string{"prepared.json", "completed.json"} {
					expected := map[string]any{"schema": float64(2), "operationId": in.Selection.OperationID, "basis": "failed-run", "failedRunSha256": fixture.ExpectedRunSha256, "configSha256": fixture.ExpectedConfigSha256, "instances": instances}
					if name == "completed.json" {
						expected["phase"] = "retired_unconfirmed"
					}
					raw, err := os.ReadFile(filepath.Join(retired, name))
					var actual map[string]any
					if err != nil || json.Unmarshal(raw, &actual) != nil || !reflect.DeepEqual(actual, expected) {
						t.Fatal("crash MCP journal crossed run/config identity or fabricated old stop evidence", name, err)
					}
				}
				if _, err := os.Lstat(filepath.Join(lifecycle, "reconciling-"+in.Selection.OperationID)); !os.IsNotExist(err) {
					t.Fatal("completed MCP reconciliation left a pending claim", err)
				}
				if _, err := os.Lstat(filepath.Join(lifecycle, "stopping")); err != nil {
					t.Fatal("maintenance removed the unconfirmed historical stop marker", err)
				}
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
			if scenario.startupEmptyHistory {
				// This scenario qualifies startup only. The following existing cases
				// own File/Chat capability probes with their own fixture identities.
				unchangedPreservedObservationTree(t, archive, retainedArchive)
				if err := next.Close(); err != nil {
					t.Fatal(err)
				}
				t.Logf("retained startup fixture %s, completion SHA256 %x; exact selection/pending/archive/fresh ACK/terminal and cold Go admitted; no Electron/provider/live-profile claim", userData, sha256.Sum256(receipt))
				return
			}
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

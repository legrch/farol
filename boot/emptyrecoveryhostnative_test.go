//go:build darwin

package boot

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Explicit fresh synthetic descriptor/store shape -> exact BUILT Go child,
// production TS host/ACK and original terminal recorder -> normal Go cold start.
// Desktop projection is a declared crash fixture, not UI, actual saved-profile
// process history, external MCP or installed-product acceptance.
func TestNativeEmptyRecoveryHostWithBuiltCore(t *testing.T) {
	testEmptyRecoveryHostWithBuiltCore(t, false, false)
}

func TestNativeInterruptedRetirementHostWithBuiltCore(t *testing.T) {
	testEmptyRecoveryHostWithBuiltCore(t, true, false)
}

func TestNativeUnacknowledgedDevHostWithBuiltCore(t *testing.T) {
	testEmptyRecoveryHostWithBuiltCore(t, false, true)
}

func TestNativePreviousQuitDevHostWithBuiltCore(t *testing.T) {
	testEmptyRecoveryHostWithBuiltCore(t, false, true, true)
}

func TestNativeInstalledEmptyHostWithBuiltCore(t *testing.T) {
	testEmptyRecoveryHostWithBuiltCore(t, false, false, false, true)
}

func testEmptyRecoveryHostWithBuiltCore(t *testing.T, interrupted, unacknowledged bool, previousQuit ...bool) {
	previousConfirmed := len(previousQuit) == 1 && previousQuit[0]
	installed := len(previousQuit) == 2 && previousQuit[1]
	if !*ingressNative {
		t.Skip("Requires exclusive native lane and -ingress-native")
	}
	repo, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema  int    `json:"schema"`
		BuildID string `json:"buildId"`
	}
	raw, err := os.ReadFile(filepath.Join(repo, "_output/build/app/build-manifest.json"))
	if err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Schema != 4 || len(manifest.BuildID) != 64 {
		t.Fatal("exact Go-enabled build prerequisite missing", err)
	}
	previous := BuildID
	BuildID = manifest.BuildID
	defer func() { BuildID = previous }()
	var in emptyRecoveryInspectionInput
	if installed {
		in = installedEmptyRecoveryFixture(t)
	} else {
		in = emptyRecoveryFixtureStateAt(t, true, interrupted, unacknowledged)
	}
	in.Selection.OperationID = freshEmptyRecoveryFixtureUUID(t)
	in.Selection.HostLifetimeID = freshEmptyRecoveryFixtureUUID(t)
	in.Selection.ChildLaunchID = freshEmptyRecoveryFixtureUUID(t)
	in.Selection.Next.BackendGeneration = "maintenance-" + freshEmptyRecoveryFixtureUUID(t)
	state := filepath.Dir(in.Profile.Root)
	userData := filepath.Dir(state)
	connector := filepath.Join(state, "secure-mcp-connector", "computer-authority")
	if err := os.MkdirAll(connector, 0700); err != nil {
		t.Fatal(err)
	}
	run := []byte("{\"syntheticFailedRun\":true}\n")
	config := []byte("{\"syntheticRetainedSetting\":true}\n")
	if unacknowledged || installed {
		// Real desktop obligation reader, with synthetic private configuration.
		run = []byte("{\"schema\":1,\"pid\":2147483647,\"startedAt\":\"2026-10-08T09:44:38.119Z\",\"bootTime\":null,\"processStart\":null}\n")
		ready := map[string]any{"visited": false, "skipped": false, "configured": false, "reachable": "unknown", "verified": nil, "needsAction": nil, "unavailable": nil, "outcomeUnknown": false}
		config, err = json.Marshal(map[string]any{"schema": 1, "revision": 1,
			"general":  map[string]any{"openAtLaunch": "home", "sidebarDefault": "full", "activityDetail": "summary"},
			"computer": map[string]any{"computerId": in.ComputerID, "generation": 1, "name": "Synthetic", "commands": "none", "workspaces": []any{}, "pendingEdit": nil},
			"setup":    map[string]any{"chatgpt": ready, "computer": ready, "connect": ready, "hosts": ready, "verify": ready}})
		if err != nil {
			t.Fatal(err)
		}
	}
	for name, bytes := range map[string][]byte{"running.json": run, "config.json": config} {
		if err := os.WriteFile(filepath.Join(state, name), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	quit := []byte("{\"schema\":1,\"at\":\"2026-10-07T21:13:07.697Z\",\"drained\":false,\"unconfirmed\":[\"go-core\"]}\n")
	if unacknowledged || installed {
		quit = []byte("{\"schema\":1,\"at\":\"2026-10-08T10:00:14.146Z\",\"drained\":false,\"unconfirmed\":[\"go-core\",\"connector\"]}\n")
		if installed {
			quit = []byte("{\"schema\":1,\"at\":\"2026-10-08T10:00:14.146Z\",\"drained\":false,\"unconfirmed\":[\"connector\",\"go-core\"]}\n")
		}
		if previousConfirmed {
			quit = []byte("{\"schema\":1,\"at\":\"2026-10-08T09:39:05.070Z\",\"drained\":true,\"unconfirmed\":[]}\n")
		}
		lifecycle := filepath.Join(connector, "mcp-lifecycle")
		if err := os.Mkdir(lifecycle, 0700); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"stopping", "prepared-" + fmt.Sprintf("%064x", 3)} {
			if err := os.WriteFile(filepath.Join(lifecycle, name), []byte("1\n"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if interrupted || unacknowledged || installed {
		if err := os.WriteFile(filepath.Join(state, "last-quit.json"), quit, 0600); err != nil {
			t.Fatal(err)
		}
	}
	profile := in.Profile
	in.Profile = ProfileBinding{}
	fixture := struct {
		Input                                   emptyRecoveryInspectionInput
		Profile                                 ProfileBinding
		ExpectedRunSha256, ExpectedConfigSha256 string
		ExpectedQuitSha256                      string `json:",omitempty"`
		UnacknowledgedDev                       bool   `json:",omitempty"`
		PreviousConfirmedQuit                   bool   `json:",omitempty"`
	}{Input: in, Profile: profile, ExpectedRunSha256: hex.EncodeToString(sumFixture(run)), ExpectedConfigSha256: hex.EncodeToString(sumFixture(config))}
	fixture.UnacknowledgedDev = unacknowledged
	fixture.PreviousConfirmedQuit = previousConfirmed
	if interrupted || unacknowledged || installed {
		fixture.ExpectedQuitSha256 = hex.EncodeToString(sumFixture(quit))
	}
	raw, err = json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	inputPath := filepath.Join(userData, "host-qualification.json")
	if err := os.WriteFile(inputPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	// Whole-artifact SDK/input attestation has a separate bounded host budget.
	// The production child still owns its unchanged 5s/8s pipe deadlines.
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	node := filepath.Join(os.Getenv("HOME"), ".nvm/versions/node/v24.20.0/bin/node")
	cmd := exec.CommandContext(ctx, node, filepath.Join(repo, "tests/e2e/closed-empty-chat-host.e2e.mjs"), inputPath)
	cmd.Dir = repo
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("original host qualification failed; retain %s: %v, %s", userData, err, out)
	}
	var result struct {
		Phase string `json:"phase"`
	}
	if json.Unmarshal(out, &result) != nil || result.Phase != "prepared_for_cold_start" {
		t.Fatal("missing exact original host result", string(out))
	}
	receipt, err := os.ReadFile(filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID, "maintenance-completed.json"))
	if err != nil {
		t.Fatal(err)
	}
	evidenceParent := filepath.Join(repo, "_output/evidence/empty-chat-host-native")
	if err := os.MkdirAll(evidenceParent, 0700); err != nil {
		t.Fatal(err)
	}
	evidence := filepath.Join(evidenceParent, in.Selection.OperationID)
	if err := os.Mkdir(evidence, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(evidence, "completed.json"), receipt, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("built-core host receipt retained: %s; SHA256 %x", evidence, sha256.Sum256(receipt))
	if _, err := os.Lstat(filepath.Join(state, "running.json")); !os.IsNotExist(err) {
		t.Fatal("failed run not retained away from live marker", err)
	}
	if interrupted || unacknowledged || installed {
		name := "failed-last-quit.json"
		if previousConfirmed {
			name = "previous-last-quit.json"
		}
		archivedQuit, err := os.ReadFile(filepath.Join(profile.Root, "chat-retired-"+in.Selection.OperationID, name))
		if err != nil || string(archivedQuit) != string(quit) {
			t.Fatal("original failed Quit not preserved", err)
		}
		if _, err := os.Lstat(filepath.Join(state, "last-quit.json")); !os.IsNotExist(err) {
			t.Fatal("live failed Quit not archived", err)
		}
	}
	if unacknowledged || installed {
		if retained, err := os.ReadFile(filepath.Join(state, "config.json")); err != nil || string(retained) != string(config) {
			t.Fatal("configuration changed", err)
		}
		var completed struct {
			UnacknowledgedDev      struct{ OriginalRetirement, OriginalACK, OriginalTerminal, TerminalReceiptScope, OriginalQuitScope, PreviousConfirmedQuitSha256, FailedQuitSha256 string }
			InstalledEmptyLifetime struct{ OriginalRetirement, OriginalACK, OriginalTerminal, TerminalReceiptScope, OriginalQuitScope, PreviousConfirmedQuitSha256, FailedQuitSha256 string }
			InterruptedRetirement  json.RawMessage
		}
		if err := json.Unmarshal(receipt, &completed); err != nil {
			t.Fatal(err)
		}
		if installed {
			if completed.UnacknowledgedDev.OriginalRetirement != "" {
				t.Fatal("installed maintenance relabeled Dev")
			}
			completed.UnacknowledgedDev = completed.InstalledEmptyLifetime
		}
		if completed.UnacknowledgedDev.OriginalRetirement != "absent" || completed.UnacknowledgedDev.OriginalACK != "absent" || completed.UnacknowledgedDev.OriginalTerminal != "unobserved" || completed.UnacknowledgedDev.TerminalReceiptScope != "new-maintenance-child" || len(completed.InterruptedRetirement) != 0 {
			t.Fatal("invented original terminal/ACK")
		}
		if previousConfirmed && (completed.UnacknowledgedDev.OriginalQuitScope != "previous-lifetime" || completed.UnacknowledgedDev.PreviousConfirmedQuitSha256 != hex.EncodeToString(sumFixture(quit)) || completed.UnacknowledgedDev.FailedQuitSha256 != "") {
			t.Fatal("previous clean Quit incorrectly attributed to interrupted lifetime")
		}
		if _, err := os.Stat(filepath.Join(connector, "mcp-lifecycle", "revoked-"+fmt.Sprintf("%064x", 3))); err != nil {
			t.Fatal("original prepared connector not revoked", err)
		}
		retired, err := os.ReadFile(filepath.Join(connector, "mcp-lifecycle", "retired-"+in.Selection.OperationID, "completed.json"))
		if err != nil {
			t.Fatal("missing inactive connector receipt", err)
		}
		var reconciled struct{ Phase string }
		if json.Unmarshal(retired, &reconciled) != nil || reconciled.Phase != "retired_unconfirmed" {
			t.Fatal("connector falsely confirmed", string(retired))
		}
	}
	if err := refusePendingEmptyRecovery(profile); err != nil {
		t.Fatal(err)
	}
	launch := NativeLaunch{Profile: profile, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Home: profile.Root, StoreMode: "open", SettingsMutations: true, HostLifetimeID: "qualified-cold-start-host", ChildLaunchID: "qualified-cold-start-child", PreviousHostDrainConfirmed: true}
	next, err := NewNativeRuntime(context.Background(), launch, "qualified-cold-start")
	if err != nil {
		t.Fatal("cold start did not consume real terminal handoff", err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func sumFixture(raw []byte) []byte { value := sha256.Sum256(raw); return value[:] }

func freshEmptyRecoveryFixtureUUID(t *testing.T) string {
	t.Helper()
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		t.Fatal(err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

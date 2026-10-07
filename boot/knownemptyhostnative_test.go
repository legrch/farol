//go:build darwin

package boot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// Real built original child and frozen TS comparison failure -> current
// inspection/one-shot completion -> real original recorder -> current cold start.
// Crash/desktop/known-error provenance are synthetic, not saved-profile proof.
func TestNativeKnownEmptyRecoveryHostWithBuiltCores(t *testing.T) {
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
		t.Fatal("exact current Go build missing", err)
	}
	previous := BuildID
	defer func() { BuildID = previous }()
	runKnownEmptyScenarios(func(scenario string) bool {
		return t.Run(scenario, func(t *testing.T) {
			BuildID = "eaa9c685af409f30fd96475368f7c171532ceea4b2d39873f3eabd2adb9008bb"
			in := emptyRecoveryFixtureAt(t, true)
			in.Selection.OperationID = freshEmptyRecoveryFixtureUUID(t)
			in.Selection.HostLifetimeID = freshEmptyRecoveryFixtureUUID(t)
			in.Selection.ChildLaunchID = freshEmptyRecoveryFixtureUUID(t)
			in.Selection.Next.BackendGeneration = "maintenance-" + freshEmptyRecoveryFixtureUUID(t)
			state := filepath.Dir(in.Profile.Root)
			userData := filepath.Dir(state)
			if err := os.MkdirAll(filepath.Join(state, "secure-mcp-connector/computer-authority"), 0700); err != nil {
				t.Fatal(err)
			}
			run, config := []byte("{\"syntheticFailedRun\":true}\n"), []byte("{\"syntheticRetainedSetting\":true}\n")
			for name, data := range map[string][]byte{"running.json": run, "config.json": config} {
				if err := os.WriteFile(filepath.Join(state, name), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			profile := in.Profile
			in.Profile = ProfileBinding{}
			fixture := struct {
				Input                                         emptyRecoveryInspectionInput
				Profile                                       ProfileBinding
				ExpectedRunSha256, ExpectedConfigSha256, Case string
			}{in, profile, hex.EncodeToString(sumFixture(run)), hex.EncodeToString(sumFixture(config)), scenario}
			raw, err := json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			inputPath := filepath.Join(userData, "known-host-qualification.json")
			if err := os.WriteFile(inputPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, filepath.Join(os.Getenv("HOME"), ".nvm/versions/node/v24.20.0/bin/node"), filepath.Join(repo, "tests/e2e/known-empty-chat-host.e2e.mjs"), inputPath)
			cmd.Dir = repo
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("original qualification failed; retain %s: %v, %s", userData, err, out)
			}
			var result struct {
				Phase string `json:"phase"`
			}
			if json.Unmarshal(out, &result) != nil {
				t.Fatal(string(out))
			}
			t.Logf("known-completion fixture retained: %s; original operation %s; %s", userData, in.Selection.OperationID, result.Phase)
			if scenario == "archive-corrupt" || scenario == "archive-late" {
				expected := "archive_corruption_refused"
				if scenario == "archive-late" {
					expected = "late_archive_change_refused"
				}
				if result.Phase != expected || refusePendingEmptyRecovery(profile) == nil {
					t.Fatal(result.Phase, "corrupted archive cleared pending")
				}
				return
			}
			if scenario == "attempt" {
				if result.Phase != "prior_attempt_refused" {
					t.Fatal(result.Phase)
				}
				return
			}
			if result.Phase != "prepared_for_cold_start" || refusePendingEmptyRecovery(profile) != nil {
				t.Fatal("completion unavailable", result.Phase)
			}
			BuildID = manifest.BuildID
			launch := NativeLaunch{Profile: profile, OwnerID: in.OwnerID, ComputerID: in.ComputerID, Home: profile.Root, StoreMode: "open", SettingsMutations: true, HostLifetimeID: "qualified-completion-host", ChildLaunchID: "qualified-completion-child", PreviousHostDrainConfirmed: true}
			next, err := NewNativeRuntime(context.Background(), launch, "qualified-completion-cold-start")
			if err != nil {
				t.Fatal("current cold start refused real original recorder", err)
			}
			if err := next.Close(); err != nil {
				t.Fatal(err)
			}
		})
	})
}

// A failed runner does not prove descendant closure. Stop before another
// fixture can use the native lane; the original failure remains the result.
func runKnownEmptyScenarios(run func(string) bool) {
	for _, scenario := range []string{"complete", "attempt", "archive-corrupt", "archive-late"} {
		if !run(scenario) {
			return
		}
	}
}

func TestKnownEmptyRecoveryScenarioSequence(t *testing.T) {
	cases := []string{"complete", "attempt", "archive-corrupt", "archive-late"}
	for failedAt := -1; failedAt < len(cases); failedAt++ {
		var observed []string
		runKnownEmptyScenarios(func(scenario string) bool {
			observed = append(observed, scenario)
			return failedAt < 0 || scenario != cases[failedAt]
		})
		expected := cases
		if failedAt >= 0 {
			expected = cases[:failedAt+1]
		}
		if !reflect.DeepEqual(observed, expected) {
			t.Fatalf("failedAt %d: later scenarios ran after failure: got %v, want %v", failedAt, observed, expected)
		}
	}
}

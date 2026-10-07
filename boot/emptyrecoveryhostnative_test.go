//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	in := emptyRecoveryFixtureAt(t, true)
	state := filepath.Dir(in.Profile.Root)
	userData := filepath.Dir(state)
	connector := filepath.Join(state, "secure-mcp-connector", "computer-authority")
	if err := os.MkdirAll(connector, 0700); err != nil {
		t.Fatal(err)
	}
	run := []byte("{\"syntheticFailedRun\":true}\n")
	config := []byte("{\"syntheticRetainedSetting\":true}\n")
	for name, bytes := range map[string][]byte{"running.json": run, "config.json": config} {
		if err := os.WriteFile(filepath.Join(state, name), bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	profile := in.Profile
	in.Profile = ProfileBinding{}
	fixture := struct {
		Input                                   emptyRecoveryInspectionInput
		Profile                                 ProfileBinding
		ExpectedRunSha256, ExpectedConfigSha256 string
	}{in, profile, hex.EncodeToString(sumFixture(run)), hex.EncodeToString(sumFixture(config))}
	raw, err = json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	inputPath := filepath.Join(userData, "host-qualification.json")
	if err := os.WriteFile(inputPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
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
	if _, err := os.Lstat(filepath.Join(state, "running.json")); !os.IsNotExist(err) {
		t.Fatal("failed run not retained away from live marker", err)
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

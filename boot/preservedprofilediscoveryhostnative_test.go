//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Actual built CLI children through the TypeScript adapter, private filesystem
// and canonical module owners. Browser/Settings remain controlled fixtures. This
// observes candidate metadata only; no Electron, preparation or recovery grant.
func TestNativePreservedProfileDiscoveryWithBuiltCore(t *testing.T) {
	if !*ingressNative || !*preservedProfileNative {
		t.Skip("requires exclusive built-core lane, -ingress-native and -preserved-profile-native")
	}
	repo, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema                            int
		BuildID, SourceCommit, SourceMode string
		Dirty, InputExact                 bool
	}
	raw, err := os.ReadFile(filepath.Join(repo, "_output/build/app/build-manifest.json"))
	if err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Schema != 4 || len(manifest.BuildID) != 64 || manifest.Dirty || !manifest.InputExact || manifest.SourceMode != "head-exact" {
		t.Fatal("exact clean built-core prerequisite missing", err)
	}
	head, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil || strings.TrimSpace(string(head)) != manifest.SourceCommit {
		t.Fatal("build source does not match current committed checkout", err)
	}
	status, err := exec.Command("git", "-C", repo, "status", "--porcelain").Output()
	if err != nil || len(status) != 0 {
		t.Fatal("built-core lane source is dirty", err)
	}
	originalBuild := BuildID
	BuildID = manifest.BuildID
	defer func() { BuildID = originalBuild }()
	for _, withFile := range []bool{false, true} {
		name := "empty-mutations"
		if withFile {
			name = "completed-file-mutation"
		}
		t.Run(name, func(t *testing.T) {
			temp := filepath.Join(repo, "_output/tmp")
			if err := os.MkdirAll(temp, 0700); err != nil {
				t.Fatal(err)
			}
			base, err := os.MkdirTemp(temp, "preserved-discovery-host-")
			if err != nil {
				t.Fatal(err)
			}
			in, workspace := preservedProfileFixtureAt(t, base, true, withFile)
			snapshotPreservedProfileDiscoveryCustody(t, in, workspace)
			selected := preservedProfileDiscoveryRequest(in)
			selected.Profile = ProfileBinding{}
			// The existing host wire accepts an array, including the empty set.
			// A nil Go slice would encode null before any native child starts.
			if selected.Mutations == nil {
				selected.Mutations = []mutationrepo.ExpectedOwnerRecord{}
			}
			fixture := struct {
				Schema   string                              `json:"schema"`
				Input    preservedProfileInspectionInput     `json:"input"`
				Expected chatport.PreservedRecoverySelection `json:"expected"`
				Profile  ProfileBinding                      `json:"profile"`
				Home     string                              `json:"home"`
			}{"farol.preserved-discovery-native/1", selected, in.Selection, in.Profile, base}
			raw, err := json.Marshal(fixture)
			if err != nil {
				t.Fatal(err)
			}
			input := filepath.Join(base, "discovery-qualification.json")
			if err := os.WriteFile(input, raw, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
			defer cancel()
			node, err := exec.LookPath("node")
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(ctx, node, filepath.Join(repo, "tests/e2e/preserved-discovery-child.e2e.mjs"), input)
			cmd.Dir = repo
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("original built discovery attempt unconfirmed; retain %s: %v %s", base, err, output)
			}
			var reply struct {
				Schema, Phase, BuildID, SourceCommit string
				Selection                            chatport.PreservedRecoverySelection
			}
			if json.Unmarshal(output, &reply) != nil || reply.Schema != fixture.Schema || reply.Phase != "observed" || reply.BuildID != manifest.BuildID || reply.SourceCommit != manifest.SourceCommit || reply.Selection != in.Selection {
				t.Fatal("built discovery did not return the selected canonical metadata")
			}
			t.Log("retained actual built discovery fixture:", base, "original UNKNOWN/profile/workspace intact; no recovery authority")
		})
	}
}

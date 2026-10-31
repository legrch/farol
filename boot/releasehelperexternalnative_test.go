//go:build darwin

package boot

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// An explicitly selected, hash-pinned shipped helper runs against inert app
// trees and an owned cat predecessor. No installed path, profile, real app or
// LaunchServices operation is changed. This isolates helper execution from the
// desktop observer's lifetime; it does not qualify a shared installation.
func TestLiveHelperNativeExternalPackage(t *testing.T) {
	liveNativeRequire(t)
	executable := externalLiveHelper(t)
	f := newLiveNativeFixture(t, true)
	f.removeAfterSuccess(t)
	f.helperExecutable = executable
	externalApply(t, f, nil, nil)
}

func externalLiveHelper(t *testing.T) string {
	t.Helper()
	executable, expected := os.Getenv("FAROL_TEST_EXTERNAL_LIVE_HELPER"), os.Getenv("FAROL_TEST_EXTERNAL_LIVE_HELPER_SHA256")
	if executable == "" && expected == "" {
		t.Skip("explicit shipped helper and digest required")
	}
	if !filepath.IsAbs(executable) || filepath.Clean(executable) != executable || len(expected) != 64 {
		t.Fatal("invalid external helper selection")
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != expected {
		t.Fatal("external helper digest mismatch")
	}
	return executable
}

func externalApply(t *testing.T, f *liveNativeFixture, source, target map[string]any) {
	t.Helper()
	f.arm(t, "")
	request := f.request("apply", false)
	if source != nil {
		request["source"], request["target"] = source, target
		request["drain"] = map[string]any{"status": "reconciled", "acceptedSource": source["buildId"], "acceptedTarget": target["buildId"]}
	}
	outcome := f.run(t, request, true)
	f.wantWaitingFrame(t, request, outcome.ack)
	expectedTerminal := `{"phase": "verified", "operationId": "` + strings.Repeat("1", 32) + `"}` + "\n"
	t.Logf("shipped helper exit=%d terminal=%q stderr=%q", outcome.exit, outcome.stdout, outcome.stderr)
	if outcome.cmd.Path != f.helperExecutable || outcome.exit != 0 || !bytes.Equal(outcome.stdout, []byte(expectedTerminal)) || len(outcome.stderr) != 0 {
		t.Fatal("shipped helper did not complete the independent inert apply")
	}
	if f.phase(t) != "verified" {
		t.Fatal("external helper did not verify inert pair")
	}
}

// Real tree bytes are copied read-only from explicit selections. All writes
// remain in a fresh disposable legacy home, with relaunch disabled.
func TestLiveHelperNativeExternalPackageTrees(t *testing.T) {
	liveNativeRequire(t)
	executable := externalLiveHelper(t)
	source := os.Getenv("FAROL_TEST_EXTERNAL_SOURCE_APP")
	sourceDigest := os.Getenv("FAROL_TEST_EXTERNAL_SOURCE_DIGEST")
	targetRoot := os.Getenv("FAROL_TEST_TARGET_PACKAGE")
	if !filepath.IsAbs(source) || !filepath.IsAbs(targetRoot) || len(sourceDigest) != 64 {
		t.Skip("explicit real source and target trees required")
	}
	var build struct {
		Version string `json:"version"`
		BuildID string `json:"buildId"`
	}
	data, err := os.ReadFile(filepath.Join(source, "Contents/Resources/app/build-identity.json"))
	if err != nil || json.Unmarshal(data, &build) != nil {
		t.Fatal("source identity invalid", err)
	}
	var artifact struct {
		Version string `json:"version"`
		BuildID string `json:"buildId"`
		Digest  string `json:"artifactSha256"`
		App     string `json:"artifactPath"`
	}
	data, err = os.ReadFile(filepath.Join(targetRoot, "_output/package/artifact.json"))
	if err != nil || json.Unmarshal(data, &artifact) != nil || artifact.App != filepath.Join(targetRoot, "_output/package/Farol.app") {
		t.Fatal("target identity invalid", err)
	}
	f := newLiveNativeFixture(t, false)
	f.removeAfterSuccess(t)
	f.helperExecutable, f.traceStall = executable, true
	for _, pair := range [][2]string{{source, filepath.Join(f.home, "Applications/Farol.app")}, {artifact.App, filepath.Join(f.operation, "staged.app")}} {
		cmd := exec.Command("/usr/bin/ditto", pair[0], pair[1])
		cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatal("owned tree copy failed", err, string(out))
		}
	}
	externalApply(t, f, map[string]any{"digest": sourceDigest, "version": build.Version, "buildId": build.BuildID}, map[string]any{"digest": artifact.Digest, "version": artifact.Version, "buildId": artifact.BuildID})
}

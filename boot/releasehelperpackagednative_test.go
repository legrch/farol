//go:build darwin

package boot

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Real packaged trees exercise the production verifier's size and symlink
// topology. Only the explicitly selected helper runs; the application itself
// is not launched and the predecessor is owned /bin/cat. This is helper/apply
// evidence, not the installed updater or relaunch. Root must qualify the exact
// package manifests and trees before selecting the packaged helper lane.
func TestLiveHelperNativePackagedTrees(t *testing.T) {
	liveNativeRequire(t)
	source, target := os.Getenv("FAROL_TEST_SOURCE_PACKAGE"), os.Getenv("FAROL_TEST_TARGET_PACKAGE")
	if !filepath.IsAbs(source) || !filepath.IsAbs(target) {
		t.Skip("explicit packaged pair required")
	}
	f := newLiveNativeFixture(t, false)
	f.removeAfterSuccess(t)
	f.traceStall = true
	if os.Getenv("FAROL_TEST_PACKAGED_HELPER") == "1" {
		f.helperExecutable = filepath.Join(target, "_output/package/Farol.app/Contents/Resources/app/farol-backend")
	}
	build := func(root, destination string) map[string]any {
		t.Helper()
		var artifact struct {
			Version string `json:"version"`
			BuildID string `json:"buildId"`
			Digest  string `json:"artifactSha256"`
			App     string `json:"artifactPath"`
		}
		data, err := os.ReadFile(filepath.Join(root, "_output/package/artifact.json"))
		if err != nil || json.Unmarshal(data, &artifact) != nil || artifact.App != filepath.Join(root, "_output/package/Farol.app") {
			t.Fatal("package selection invalid", err)
		}
		copy := exec.Command("/usr/bin/ditto", artifact.App, destination)
		copy.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
		if out, err := copy.CombinedOutput(); err != nil {
			t.Fatal("owned package copy failed", err, string(out))
		}
		return map[string]any{"digest": artifact.Digest, "version": artifact.Version, "buildId": artifact.BuildID}
	}
	s := build(source, filepath.Join(f.home, "Applications/Farol.app"))
	d := build(target, filepath.Join(f.operation, "staged.app"))
	t.Logf("source=%s target=%s packagedHelper=%t", s["buildId"], d["buildId"], f.helperExecutable != "")
	f.arm(t, "")
	request := f.request("apply", false)
	request["source"], request["target"] = s, d
	request["drain"] = map[string]any{"status": "reconciled", "acceptedSource": s["buildId"], "acceptedTarget": d["buildId"]}
	o := f.run(t, request, true)
	f.wantWaitingFrame(t, request, o.ack)
	if o.exit != 0 {
		t.Fatalf("packaged helper exit=%d stdout=%s stderr=%s", o.exit, o.stdout, o.stderr)
	}
	if f.phase(t) != "verified" {
		t.Fatal("packaged pair did not verify")
	}
}

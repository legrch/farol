package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/infra/native/installmove"
)

func TestInstallReleaseRunRejectsMalformedInvocation(t *testing.T) {
	for _, args := range [][]string{
		{"run-install-release-swap"},
		{"run-install-release-swap", "--installed", "/tmp/Farol.app"},
		{"run-install-release-swap", "--installed", "/Applications/Farol.app", "--evidence", "/tmp/a", "--staged-app", "/tmp/b/staged.app", "--manifest", "/tmp/a/farol-release.json"},
	} {
		var output, diag bytes.Buffer
		if code := Run(args, nil, nopWriteCloser{&output}, &diag); code != 2 || output.Len() != 0 || !strings.Contains(diag.String(), "INSTALL_INPUT_INVALID") {
			t.Fatalf("invalid installation invocation accepted: %q code=%d output=%q diagnostic=%q", args, code, output.String(), diag.String())
		}
	}
}

func TestInstallReleasePendingCustodyBlocksRetry(t *testing.T) {
	dir := t.TempDir()
	for _, phase := range []string{"pending", "unknown", "completed", "refused"} {
		record := installReleaseRecord{Schema: "farol.bootstrap-install/1", ID: strings.Repeat("a", 32), Phase: phase}
		if err := writeInstallRecord(dir, record); err != nil {
			t.Fatal(err)
		}
		err := checkedInstallRecord(dir)
		if (err == nil) != (phase == "completed" || phase == "refused") {
			t.Fatalf("phase %s admission = %v", phase, err)
		}
	}
}

func TestInstallReleaseCompletedCustodyRetainsVerifiedManifest(t *testing.T) {
	dir := t.TempDir()
	manifest, err := json.Marshal(map[string]any{
		"schema": "farol.github-release/1", "repository": "legrch/farol",
		"channel": "stable", "product": "Farol", "bundleId": "io.github.legrch.farol",
		"version": "0.5.20", "buildVersion": "76", "sourceCommit": strings.Repeat("a", 40),
		"sourceTreeDigest": strings.Repeat("b", 64), "buildId": strings.Repeat("c", 64),
		"artifactSha256": strings.Repeat("d", 64), "archiveSha256": strings.Repeat("e", 64),
		"archiveName": "Farol-0.5.20-darwin-arm64.zip", "archiveSize": 1024,
		"platform": "darwin", "arch": "arm64", "signing": "unsigned",
		"notarized": false, "sourceDirty": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	record := installReleaseRecord{Schema: "farol.bootstrap-install/2", ID: strings.Repeat("f", 32), Phase: "pending", Version: "0.5.20", BuildID: strings.Repeat("c", 64), Digest: strings.Repeat("d", 64), Installed: "/Applications/Farol.app", Profile: "/Users/owner/Library/Application Support/io.github.legrch.farol", Manifest: manifest}
	if err := writeInstallRecord(dir, record); err != nil {
		t.Fatal(err)
	}
	if err := checkedInstallRecord(dir); err == nil {
		t.Fatal("pending installer custody admitted")
	}
	record.Phase = "completed"
	if err := writeInstallRecord(dir, record); err != nil {
		t.Fatal(err)
	}
	if err := checkedInstallRecord(dir); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(dir, "current.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decoded installReleaseRecord
	if json.Unmarshal(stored, &decoded) != nil || !bytes.Equal(decoded.Manifest, manifest) {
		t.Fatal("verified manifest changed in durable installer custody")
	}
	decoded.Digest = strings.Repeat("0", 64)
	if err := writeInstallRecord(dir, decoded); err != nil {
		t.Fatal(err)
	}
	if err := checkedInstallRecord(dir); err == nil {
		t.Fatal("contradictory completed installer custody admitted")
	}
}

func TestInstallReleaseManifestBindsStagedBuildSource(t *testing.T) {
	stage := t.TempDir()
	dir := filepath.Join(stage, "Contents", "Resources", "app")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "build-identity.json")
	values := map[string]string{
		"version": "0.5.20", "buildVersion": "76", "buildId": strings.Repeat("a", 64),
		"sourceCommit": strings.Repeat("b", 40), "sourceTreeDigest": strings.Repeat("c", 64),
	}
	build := map[string]any{
		"version": values["version"], "buildVersion": values["buildVersion"],
		"buildId": values["buildId"], "sourceCommit": values["sourceCommit"],
		"sourceTreeDigest": values["sourceTreeDigest"], "updateChannel": "github-stable",
		"sourceDirty": false,
	}
	write := func() {
		t.Helper()
		data, err := json.Marshal(build)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	if !installManifestMatchesStagedBuild(stage, values) {
		t.Fatal("matching staged build refused")
	}
	build["sourceCommit"] = strings.Repeat("d", 40)
	write()
	if installManifestMatchesStagedBuild(stage, values) {
		t.Fatal("mismatched source admitted to offline startup")
	}
}

func TestInstallReleaseCustodyRefusesSymlinkAndChangedMode(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "elsewhere.json")
	data, err := json.Marshal(installReleaseRecord{Schema: "farol.bootstrap-install/1", Phase: "completed"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "current.json")); err != nil {
		t.Fatal(err)
	}
	if err := checkedInstallRecord(dir); err == nil {
		t.Fatal("symlink custody admitted")
	}
	if err := os.Remove(filepath.Join(dir, "current.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "current.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	if err := checkedInstallRecord(dir); err == nil {
		t.Fatal("world-readable custody admitted")
	}
}

func TestInstallReleaseEmptySlotRequiresConfirmedProfileAndNoSidecars(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	app := filepath.Join(root, "Farol.app")
	candidate := installReleaseManifest{Version: "0.5.20", BuildVersion: "76"}
	state, err := inspectInstallProfile(context.Background(), profile, app, candidate)
	if err != nil || !state.fresh {
		t.Fatal(err)
	}
	if err := os.Mkdir(profile, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectInstallProfile(context.Background(), profile, app, candidate); err == nil {
		t.Fatal("unconfirmed existing profile admitted")
	}
	if err := os.Remove(profile); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app+".receipt.json", []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectInstallProfile(context.Background(), profile, app, candidate); err == nil {
		t.Fatal("empty slot with existing receipt admitted")
	}
}

func TestInstallReleaseEmptySlotRefusesOccupiedPath(t *testing.T) {
	root := t.TempDir()
	app := filepath.Join(root, "Farol.app")
	if err := installEmptySlotIdentity(app); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(app, 0700); err != nil {
		t.Fatal(err)
	}
	if err := installEmptySlotIdentity(app); err == nil || err.Error() != "INSTALL_OCCUPIED_SLOT_UNSUPPORTED" {
		t.Fatalf("occupied slot admitted: %v", err)
	}
	if err := os.Remove(app); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(root, app); err != nil {
		t.Fatal(err)
	}
	if err := installEmptySlotIdentity(app); err == nil || err.Error() != "INSTALL_OCCUPIED_SLOT_UNSUPPORTED" {
		t.Fatalf("symlink slot admitted: %v", err)
	}
}

func TestInstallReleaseRefusesOnlyProductionProcessInventory(t *testing.T) {
	for _, name := range []string{
		"/Applications/Farol.app/Contents/MacOS/Farol",
		"/Applications/Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
		"/Users/runner/Library/Application Support/io.github.legrch.farol/installed-updates/op/launch-Farol.app/Contents/MacOS/Farol",
		"/Users/runner/Downloads/Farol.app/Contents/Resources/app/farol-backend",
		"/Users/runner/Downloads/Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
		"/Users/runner/build/farol-backend",
		"farol-backend",
	} {
		if err := classifyInstallProcesses("101 /usr/bin/login\n102 "+name+"\n", 42); err == nil {
			t.Fatalf("production process admitted: %q", name)
		}
	}
	for _, name := range []string{
		"/Applications/Farol Dev.app/Contents/MacOS/Farol Dev",
		"/Applications/Farol Dev.app/Contents/Resources/app/farol-backend",
		"/Applications/Farol Owner Preview.app/Contents/Resources/app/farol-backend",
		"/Applications/Another.app/Contents/Frameworks/Electron.app/Contents/MacOS/Electron",
	} {
		if err := classifyInstallProcesses("101 /usr/bin/login\n102 "+name+"\n", 42); err != nil {
			t.Fatalf("unrelated process refused: %q: %v", name, err)
		}
	}
	if err := classifyInstallProcesses("101 /usr/bin/login\n42 /private/tmp/verified-target/farol-backend\n", 42); err != nil {
		t.Fatalf("the adapter refused its own process: %v", err)
	}
	if err := classifyInstallProcesses("42 farol-backend\n43 farol-backend\n", 42); err == nil {
		t.Fatal("a second Farol backend was admitted")
	}
	if err := classifyInstallProcesses("unparsed process inventory\n", 42); err == nil {
		t.Fatal("malformed process inventory was admitted")
	}
}

func TestInstallReleaseResolvesShortElectronAtFinalFence(t *testing.T) {
	for _, tc := range []struct {
		name       string
		title      string
		resolved   string
		resolveErr bool
		wantError  string
	}{
		{"production primary", "Electron", "/Applications/Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron", false, "INSTALL_PRODUCTION_STILL_RUNNING"},
		{"production snapshot", "Electron", "/Users/runner/Library/Application Support/io.github.legrch.farol/installed-updates/op/launch-Farol.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron", false, "INSTALL_PRODUCTION_STILL_RUNNING"},
		{"production renderer helper", "Electron Helper (Renderer)", "/Applications/Farol.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)", false, "INSTALL_PRODUCTION_STILL_RUNNING"},
		{"production GPU helper", "Farol Helper (GPU)", "/Applications/Farol.app/Contents/Frameworks/Farol Helper (GPU).app/Contents/MacOS/Farol Helper (GPU)", false, "INSTALL_PRODUCTION_STILL_RUNNING"},
		{"unrelated Electron", "Electron Helper", "/Applications/Another.app/Contents/MacOS/Electron Helper", false, ""},
		{"Dev short title", "Farol Dev", "/Applications/Farol Dev.app/Contents/MacOS/Farol Dev", false, ""},
		{"vanished PID", "Electron Helper (Renderer)", "", false, ""},
		{"live unreadable PID", "Electron Helper (Renderer)", "", true, "INSTALL_PROCESS_OBSERVATION_UNKNOWN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			err := classifyInstallProcessesWithResolver("42 /private/tmp/staged.app/farol-backend\n43 "+tc.title+"\n", 42, func(pid int) (string, error) {
				calls++
				if pid != 43 {
					t.Fatalf("resolved unexpected PID %d", pid)
				}
				if tc.resolveErr {
					return "", os.ErrPermission
				}
				return tc.resolved, nil
			})
			if calls != 1 || (err == nil) != (tc.wantError == "") || err != nil && err.Error() != tc.wantError {
				t.Fatalf("calls=%d error=%v, want %q", calls, err, tc.wantError)
			}
		})
	}
}

func TestInstallReleaseResolverReadsCurrentExecutable(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS libproc only")
	}
	path, err := resolveInstallExecutable(context.Background(), os.Getpid())
	if err != nil || !filepath.IsAbs(path) {
		t.Fatalf("current executable unresolved: %q, %v", path, err)
	}
}

func TestInstallReleaseCustodyDistinguishesKnownRefusalFromUnknown(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want bool
	}{
		{&installmove.Failure{Code: "fence_refused"}, true},
		{&installmove.Failure{Code: "parent_replaced", Internal: true}, true},
		{context.DeadlineExceeded, true},
		{&installmove.Failure{Code: "move_uncertain", Uncertain: true}, false},
		{errors.New("unclassified outcome"), false},
	} {
		if got := installOutcomeKnownNoEffect(tc.err); got != tc.want {
			t.Fatalf("%v: known no-effect=%t, want %t", tc.err, got, tc.want)
		}
	}
}

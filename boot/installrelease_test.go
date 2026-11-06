package boot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func TestInstallReleaseEmptySlotRequiresAbsentProfileAndReceipts(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	app := filepath.Join(root, "Farol.app")
	if err := installFreshProfileAbsent(profile, app); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(profile, 0700); err != nil {
		t.Fatal(err)
	}
	if err := installFreshProfileAbsent(profile, app); err == nil {
		t.Fatal("empty slot with existing profile admitted")
	}
	if err := os.Remove(profile); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(app+".receipt.json", []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := installFreshProfileAbsent(profile, app); err == nil {
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
		"farol-backend",
	} {
		if err := classifyInstallProcesses("101 /usr/bin/login\n102 "+name+"\n", 42); err == nil {
			t.Fatalf("production process admitted: %q", name)
		}
	}
	for _, name := range []string{
		"/Applications/Farol Dev.app/Contents/MacOS/Farol Dev",
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

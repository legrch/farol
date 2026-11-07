package boot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var exitedInstallHelper = func(context.Context, int) bool { return true }

func installProfileFixture(t *testing.T) (string, string, installReleaseManifest, installOperation) {
	t.Helper()
	root := t.TempDir()
	profile := filepath.Join(root, "profile")
	app := filepath.Join(root, "Farol.app")
	operation := installOperation{
		ID:     strings.Repeat("a", 32),
		Source: installBuild{Digest: strings.Repeat("b", 64), Version: "0.5.18", BuildID: strings.Repeat("c", 64)},
		Target: installBuild{Digest: strings.Repeat("d", 64), Version: "0.5.19", BuildID: strings.Repeat("e", 64)},
	}
	for _, directory := range []string{profile, filepath.Join(profile, "installed-updates"), filepath.Join(profile, "installed-updates", operation.ID)} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	start := "Sun Nov  8 00:08:35 2026"
	saved := installSavedUpdate{Schema: "farol.ready-update/1", Handle: "retained-update-handle", ObservedAt: "2026-11-08T00:08:35.000Z", Phase: "completed", RunningBuildID: operation.Target.BuildID, Operation: operation}
	saved.Manifest.Schema = "farol.github-release/1"
	saved.Manifest.Repository = "legrch/farol"
	saved.Manifest.Channel = "stable"
	saved.Manifest.Product = "Farol"
	saved.Manifest.BundleID = "io.github.legrch.farol"
	saved.Manifest.Version = operation.Target.Version
	saved.Manifest.BuildVersion = "75"
	saved.Manifest.SourceCommit = strings.Repeat("2", 40)
	saved.Manifest.SourceTreeDigest = strings.Repeat("3", 64)
	saved.Manifest.BuildID = operation.Target.BuildID
	saved.Manifest.ArtifactSha256 = operation.Target.Digest
	saved.Manifest.ArchiveSha256 = strings.Repeat("4", 64)
	saved.Manifest.ArchiveName = "Farol-0.5.19-darwin-arm64.zip"
	saved.Manifest.ArchiveSize = 1024
	saved.Manifest.Platform = "darwin"
	saved.Manifest.Arch = "arm64"
	saved.Manifest.Signing = "unsigned"
	saved.Helper = &struct {
		PID          int     `json:"pid"`
		ProcessStart *string `json:"processStart"`
	}{2147483647, &start}
	writeJSON := func(name string, value any) {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	updates := filepath.Join(profile, "installed-updates")
	writeJSON(filepath.Join(updates, "last-update.json"), saved)
	writeJSON(filepath.Join(updates, operation.ID, "journal.json"), installJournal{
		Schema: "farol.installed-update-journal/1", Phase: "completed", OperationID: operation.ID,
		Source: operation.Source, Target: operation.Target,
	})
	binding := fmt.Sprintf("{\"installLocation\":\"shared\",\"operationId\":\"%s\",\"schema\":\"farol.installed-operation-slot/1\",\"source\":{\"buildId\":\"%s\",\"digest\":\"%s\",\"version\":\"%s\"},\"target\":{\"buildId\":\"%s\",\"digest\":\"%s\",\"version\":\"%s\"}}\n",
		operation.ID, operation.Source.BuildID, operation.Source.Digest, operation.Source.Version,
		operation.Target.BuildID, operation.Target.Digest, operation.Target.Version)
	if err := os.WriteFile(filepath.Join(updates, operation.ID, "slot-binding.json"), []byte(binding), 0600); err != nil {
		t.Fatal(err)
	}
	return profile, app, installReleaseManifest{Version: "0.5.20", BuildVersion: "76", ArtifactSha256: strings.Repeat("f", 64), BuildID: strings.Repeat("1", 64)}, operation
}

func TestInstallReleaseRetainedCompletedProfile(t *testing.T) {
	profile, app, candidate, operation := installProfileFixture(t)
	state, err := inspectInstallProfileWithHelper(context.Background(), profile, app, candidate, exitedInstallHelper)
	if err != nil || state.fresh {
		t.Fatalf("completed retained profile refused: %v", err)
	}
	if err := recheckInstallProfileWithHelper(context.Background(), profile, app, candidate, state, exitedInstallHelper); err != nil {
		t.Fatal(err)
	}
	same := installReleaseManifest{Version: operation.Target.Version, BuildVersion: "75", BuildID: operation.Target.BuildID, ArtifactSha256: operation.Target.Digest}
	if _, err := inspectInstallProfileWithHelper(context.Background(), profile, app, same, exitedInstallHelper); err != nil {
		t.Fatalf("same verified build refused: %v", err)
	}
	for _, changed := range []installReleaseManifest{
		{Version: "0.5.18", BuildVersion: "76"},
		{Version: "0.5.20", BuildVersion: "75"},
		{Version: operation.Target.Version, BuildVersion: "75", BuildID: candidate.BuildID, ArtifactSha256: operation.Target.Digest},
	} {
		if _, err := inspectInstallProfileWithHelper(context.Background(), profile, app, changed, exitedInstallHelper); err == nil {
			t.Fatalf("incompatible build admitted: %+v", changed)
		}
	}
	if err := os.WriteFile(filepath.Join(profile, "installed-updates", "ready.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := recheckInstallProfileWithHelper(context.Background(), profile, app, candidate, state, exitedInstallHelper); err == nil {
		t.Fatal("new pending update admitted at final fence")
	}
}

func TestInstallReleaseRetainedProfileRejectsChangedEvidence(t *testing.T) {
	for _, name := range []string{"last-update.json", "journal.json", "slot-binding.json"} {
		t.Run(name, func(t *testing.T) {
			profile, app, candidate, operation := installProfileFixture(t)
			state, err := inspectInstallProfileWithHelper(context.Background(), profile, app, candidate, exitedInstallHelper)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(profile, "installed-updates", name)
			if name != "last-update.json" {
				path = filepath.Join(profile, "installed-updates", operation.ID, name)
			}
			if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := recheckInstallProfileWithHelper(context.Background(), profile, app, candidate, state, exitedInstallHelper); err == nil {
				t.Fatal("changed retained evidence admitted")
			}
		})
	}
}

func TestInstallReleaseRejectsStartupIncompatibleRetainedRecords(t *testing.T) {
	cases := []struct {
		name, file string
		mutate     func(map[string]any)
	}{
		{"missing handle", "last-update.json", func(value map[string]any) { delete(value, "handle") }},
		{"missing observedAt", "last-update.json", func(value map[string]any) { delete(value, "observedAt") }},
		{"manifest provenance", "last-update.json", func(value map[string]any) { delete(value["manifest"].(map[string]any), "sourceCommit") }},
		{"manifest unknown field", "last-update.json", func(value map[string]any) { value["manifest"].(map[string]any)["unexpected"] = true }},
		{"helper identity", "last-update.json", func(value map[string]any) { delete(value["helper"].(map[string]any), "processStart") }},
		{"journal unknown field", "journal.json", func(value map[string]any) { value["unexpected"] = true }},
		{"operation build unknown field", "journal.json", func(value map[string]any) { value["source"].(map[string]any)["unexpected"] = true }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			profile, app, candidate, operation := installProfileFixture(t)
			path := filepath.Join(profile, "installed-updates", tc.file)
			if tc.file == "journal.json" {
				path = filepath.Join(profile, "installed-updates", operation.ID, tc.file)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]any
			if err := json.Unmarshal(data, &value); err != nil {
				t.Fatal(err)
			}
			tc.mutate(value)
			data, err = json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := inspectInstallProfileWithHelper(context.Background(), profile, app, candidate, exitedInstallHelper); err == nil {
				t.Fatal("startup-incompatible profile admitted")
			}
		})
	}
}

func TestInstallReleaseRetainedProfileRejectsLiveHelper(t *testing.T) {
	profile, app, candidate, _ := installProfileFixture(t)
	file := filepath.Join(profile, "installed-updates", "last-update.json")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var saved installSavedUpdate
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	saved.Helper.PID = os.Getpid()
	data, err = json.Marshal(saved)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := inspectInstallProfileWithHelper(context.Background(), profile, app, candidate, func(context.Context, int) bool { return false }); err == nil {
		t.Fatal("live helper admitted")
	}
}

func TestInstallReleaseManifestRequiresStableBuildVersion(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "farol-release.json")
	valid := map[string]any{
		"schema": "farol.github-release/1", "repository": "legrch/farol",
		"version": "0.5.20", "buildVersion": "76", "channel": "stable",
		"platform": "darwin", "arch": "arm64",
		"artifactSha256": strings.Repeat("a", 64), "buildId": strings.Repeat("b", 64),
	}
	check := func(want bool) {
		t.Helper()
		data, err := json.Marshal(valid)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		_, err = readInstallManifest(file)
		if (err == nil) != want {
			t.Fatalf("manifest admission=%v, want %t", err, want)
		}
	}
	check(true)
	delete(valid, "buildVersion")
	check(false)
	valid["buildVersion"] = "76"
	valid["channel"] = "owner-beta"
	check(false)
}

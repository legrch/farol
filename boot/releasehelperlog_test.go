package boot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReleaseHelperLogWritesSmallPhaseLines(t *testing.T) {
	dir := t.TempDir()
	operation, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer operation.Close()
	for _, phase := range []string{"waiting_for_exit", "new_installed", "rolled_back"} {
		writeReleaseHelperLog(operation, phase, "fixture_code")
	}
	data, err := os.ReadFile(filepath.Join(dir, "helper.log.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 || strings.Contains(string(data), dir) {
		t.Fatal(string(data))
	}
	for _, line := range lines {
		var value struct {
			Phase, Code, Timestamp string
			PID                    int
		}
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			t.Fatal(err)
		}
		if _, err := time.Parse(time.RFC3339Nano, value.Timestamp); err != nil {
			t.Fatal(err)
		}
		if value.Phase == "" || value.Code != "fixture_code" || value.PID != os.Getpid() {
			t.Fatal(value)
		}
	}
}

func TestReleaseHelperLogRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "untouched")
	if err := os.WriteFile(outside, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "helper.log.jsonl")); err != nil {
		t.Fatal(err)
	}
	operation, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer operation.Close()
	writeReleaseHelperLog(operation, "failed", "fixture")
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "unchanged" {
		t.Fatal(string(data), err)
	}
}

package process

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProjectTerminalDetailsUsesCompleteValidatedOriginal(t *testing.T) {
	result, _, _, _, _ := retainedFixture([]byte("git status clean"), []byte("password=example-secret"))
	result.Observation.OutputLimitReached = false
	details, ok := ProjectTerminalDetails(result, "git status --short", func(s string) (string, error) { return s, nil })
	if !ok || details.Command.Text != "git status --short" || details.Stdout.Text != "git status clean" || details.Stderr.Text != "[REDACTED]" {
		t.Fatalf("unexpected projection: %+v, valid=%v", details, ok)
	}
	encoded, err := json.Marshal(details)
	if err != nil || strings.Contains(string(encoded), "example-secret") {
		t.Fatal("secret reached projected details", err)
	}
}

func TestProjectTerminalDetailsWithholdsTruncatedAndUnavailable(t *testing.T) {
	result, _, _, _, _ := retainedFixture([]byte("partial output"), nil)
	details, ok := ProjectTerminalDetails(result, "pwd", func(s string) (string, error) { return s, nil })
	if !ok || details.Stdout.State != "unavailable" || details.Stdout.Text != "" || details.Stderr.State != "unavailable" {
		t.Fatal("limited capture exposed a partial stream")
	}
	result.Observation.OutputLimitReached = false
	details, ok = ProjectTerminalDetails(result, "pwd", nil)
	if !ok || details.Command.State != "unavailable" || details.Stdout.State != "unavailable" || details.Stdout.Text != "" {
		t.Fatal("missing filter exposed data")
	}
	result.Observation.StdoutNext++
	if _, ok = ProjectTerminalDetails(result, "pwd", nil); ok {
		t.Fatal("invalid terminal observation accepted")
	}
}

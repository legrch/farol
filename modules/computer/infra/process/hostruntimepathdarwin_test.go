//go:build darwin

package process

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestHostRuntimeUserPathSyntaxIsClosed(t *testing.T) {
	for _, tc := range []struct {
		path  string
		valid bool
	}{
		{"/opt/homebrew/bin:/usr/bin", true},
		{"/opt/homebrew/bin:/opt/homebrew/bin", true},
		{"", false},
		{"/opt/homebrew/bin:", false},
		{".:/usr/bin", false},
		{"/usr/../bin", false},
		{"/usr/bin\x00:/bin", false},
	} {
		if validHostSearchPath(tc.path) != tc.valid {
			t.Fatalf("PATH syntax verdict mismatch: %q", tc.path)
		}
	}
}

func TestHostRuntimeProbeTimeoutAndOverflowFailClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	_, err := runHostProbe(ctx, "/bin/sh", []string{"-c", "sleep 2"}, []string{"PATH=/bin:/usr/bin"}, os.TempDir(), 64)
	if !errors.Is(err, errShellEnvironmentUnknown) && !errors.Is(err, errShellEnvironmentTimeout) {
		t.Fatalf("timed out probe was accepted: %v", err)
	}
	out, err := runHostProbe(context.Background(), "/bin/sh", []string{"-c", "printf 'oversized-output'"}, []string{"PATH=/bin:/usr/bin"}, os.TempDir(), 4)
	if !errors.Is(err, errShellEnvironmentUnknown) {
		t.Fatalf("overflowed probe was accepted: %v output %q", err, out)
	}
}

func TestHostRuntimeIgnoresTerminalHintAndUsesAccountLoginShell(t *testing.T) {
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("TERM_PROGRAM", "TestTerminal")
	t.Setenv("PATH", "/owner/first:/usr/bin")
	selected, err := CaptureUserEnvironment(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if selected.Source != "login-shell" || !validHostSearchPath(selected.Path) || selected.Path == "/owner/first:/usr/bin" {
		t.Fatalf("Terminal hint replaced the account's login PATH: %+v", selected)
	}
}

func TestHostRuntimeFrameRefusesDuplicatesAndMalformedFields(t *testing.T) {
	nonce := "abc"
	frame := "\x00FAROL_ENV_BEGIN_abc\x00/usr/bin\x00\x00\x00\x00FAROL_ENV_END_abc\x00"
	if fields, err := framedUserEnvironment([]byte("chatter"+frame+"tail"), nonce); err != nil || fields[0] != "/usr/bin" {
		t.Fatalf("valid framed PATH refused: %q %v", fields, err)
	}
	for _, raw := range []string{frame + frame, frame[:len(frame)-1], "\x00FAROL_ENV_BEGIN_abc\x00/usr/bin\x00\x00\x00FAROL_ENV_END_abc\x00"} {
		if _, err := framedUserEnvironment([]byte(raw), nonce); err == nil {
			t.Fatalf("malformed frame accepted")
		}
	}
}

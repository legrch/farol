//go:build darwin

package process

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	if _, err := runHostProbe(context.Background(), "/bin/sh", []string{"-c", "printf 'valid'; printf 'startup denied' >&2"},
		[]string{"PATH=/bin:/usr/bin"}, os.TempDir(), 64); !errors.Is(err, errShellEnvironmentUnknown) {
		t.Fatalf("probe accepted a frame despite startup stderr: %v", err)
	}
}

func TestHostRuntimeIgnoresTerminalHintAndUsesAccountLoginShell(t *testing.T) {
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("TERM_PROGRAM", "TestTerminal")
	t.Setenv("PATH", "/owner/first:/usr/bin")
	selected, err := CaptureUserEnvironment(context.Background())
	if err != nil {
		// The installed account may source tools outside this probe's exact
		// read/exec closure. Refusal is the safe result, not another Git.
		if !errors.Is(err, errShellEnvironmentUnknown) {
			t.Fatalf("unexpected native probe failure: %v", err)
		}
		return
	}
	if selected.Source != "login-shell" || !validHostSearchPath(selected.Path) || selected.Path == "/owner/first:/usr/bin" {
		t.Fatalf("Terminal hint replaced the account's login PATH: %+v", selected)
	}
}

func TestConfinedLoginProbeRejectsStartupWrites(t *testing.T) {
	home, err := os.MkdirTemp("/private/tmp", "farol-login-probe-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	target := filepath.Join(home, "forbidden")
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte("print -r -- forbidden > "+target+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	args, err := confinedLoginArguments("/bin/zsh", home, home, []string{"-i", "-c", "print -r -- ready"})
	if err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "ZDOTDIR=" + home, "PATH=/usr/bin:/bin", "TERM=dumb"}
	_, probeErr := runHostProbe(context.Background(), seatbeltExecutable, args, env, home, hostEnvironmentOutputLimit)
	_, statErr := os.Stat(target)
	if !errors.Is(probeErr, errShellEnvironmentUnknown) {
		t.Fatalf("startup write did not fail closed: probe=%v target=%v", probeErr, statErr)
	}
	if !os.IsNotExist(statErr) {
		t.Fatalf("startup write escaped Seatbelt: %v", statErr)
	}
}

func TestConfinedLoginProbeRejectsLinkedStartupFile(t *testing.T) {
	home := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("PATH=/unapproved:$PATH\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, ".zshrc")); err != nil {
		t.Fatal(err)
	}
	if _, err := confinedLoginArguments("/bin/zsh", home, home, []string{"-i", "-c", ":"}); !errors.Is(err, errShellEnvironmentUnknown) {
		t.Fatalf("linked startup source was accepted: %v", err)
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

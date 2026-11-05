//go:build darwin && farol_native_root_scoped

package process

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Disposable launcher and real Seatbelt compiler only; no Brain command,
// installed profile, public MCP transport or provider is exercised.
func TestNativeBrainLikeLauncher(t *testing.T) {
	base, err := os.MkdirTemp("/private/tmp", "farol-launcher-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	scratch, err := os.MkdirTemp("/private/tmp", "farol-launcher-scratch-")
	if err != nil {
		t.Fatal(err)
	}
	complete := false
	t.Cleanup(func() {
		if !complete {
			t.Logf("retain launcher evidence %s %s", base, scratch)
			return
		}
		for _, p := range []string{base, scratch} {
			if err := os.RemoveAll(p); err != nil {
				t.Error(err)
			}
		}
	})
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	identity := func(p string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(p)
		must(err)
		st := info.Sys().(*syscall.Stat_t)
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}
	}
	hash := func(p string) string {
		t.Helper()
		b, err := os.ReadFile(p)
		must(err)
		h := sha256.Sum256(b)
		return hex.EncodeToString(h[:])
	}
	root, home := filepath.Join(base, "project"), filepath.Join(base, "home")
	must(os.Mkdir(root, 0700))
	must(os.Mkdir(home, 0700))
	launcher := filepath.Join(root, "brain-like")
	must(os.WriteFile(launcher, []byte("#!/usr/bin/env bash\nset -eu\nsource=$0\nif [[ -L $source ]]; then source=$(/usr/bin/readlink \"$source\"); fi\ndir=$(/usr/bin/dirname \"$source\")\ncd \"$dir\"\n/bin/pwd\n/usr/bin/printf 'discovery-complete\\n'\n"), 0700))
	must(os.Symlink("brain-like", filepath.Join(root, "brain-link")))
	raw, err := os.ReadFile("../../../../tooling/shell-platform.json")
	must(err)
	var declaration struct{ Executables []ExecutablePin }
	must(json.Unmarshal(raw, &declaration))
	declared := map[string]ExecutablePin{}
	for _, pin := range declaration.Executables {
		declared[pin.Path] = pin
	}
	for _, scenario := range []struct {
		name, entry string
		candidate   bool
	}{
		{"baseline-canonical", "brain-like", false},
		{"baseline-printf-refused", "brain-like", true},
		{"candidate-canonical", "brain-like", true},
		{"candidate-symlink", "brain-link", true},
		{"candidate-stat-alias-refused", "", true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			s, c := rootScopedFixture(t)
			s.Home, s.Scratch, s.ScratchIdentity = home, scratch, identity(scratch)
			s.MechanismSHA256 = hash(seatbeltExecutable)
			paths := []string{"/bin/bash", "/bin/sh", "/bin/cat", "/bin/ls", "/bin/sleep", "/usr/bin/env", "/bin/rm"}
			if scenario.candidate {
				paths = append(paths, "/usr/bin/dirname", "/bin/pwd", "/usr/bin/readlink")
			}
			if scenario.candidate && scenario.name != "baseline-printf-refused" {
				paths = append(paths, "/usr/bin/printf")
			}
			s.Executables = nil
			for _, p := range paths {
				pin, ok := declared[p]
				if !ok || pin.SHA256 != hash(p) {
					t.Fatalf("declared image missing or changed: %s", p)
				}
				s.Executables = append(s.Executables, pin)
			}
			s.Snapshot.Participant.Grant.Workspaces[0].Root = root
			s.Snapshot.Approval.Workspaces[0].Root = root
			s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(root)
			c.Root, c.Cwd, c.RootIdentity = root, root, identity(root)
			c.Executable, c.ExecutableSHA256 = "/bin/bash", hash("/bin/bash")
			c.Args = []string{"-c", "exec ./" + scenario.entry}
			if scenario.name == "candidate-stat-alias-refused" {
				c.Args = []string{"-c", "exec /usr/bin/stat ."}
			}
			c.Input = nil
			c.Write = false
			c.Environment = seatbeltEnvironment(s, false)
			plan, err := compileSeatbelt(s, c)
			must(err)
			if !strings.Contains(plan.source, "(deny network*)") || hasParameterRule(plan, "allow file-write*", "subpath", root) || hasParameterRule(plan, "allow file-read*", "subpath", home) {
				t.Fatal("scope widened")
			}
			args := append(append(append([]string(nil), plan.arguments...), c.Executable), c.Args...)
			child := exec.Command(seatbeltExecutable, args...)
			child.Env, child.Dir, child.WaitDelay = c.Environment, root, time.Second
			var stdout, stderr bytes.Buffer
			child.Stdout, child.Stderr = &stdout, &stderr
			must(configure(child))
			must(child.Start())
			done := make(chan error, 1)
			go func() { done <- child.Wait() }()
			var result error
			select {
			case result = <-done:
			case <-time.After(10 * time.Second):
				stopErr := child.Process.Kill()
				select {
				case <-done:
				case <-time.After(2 * time.Second):
				}
				t.Fatalf("original child unconfirmed; exact-root stop=%v; retain fixture", stopErr)
			}
			if !scenario.candidate || scenario.name == "baseline-printf-refused" || scenario.name == "candidate-stat-alias-refused" {
				exit, ok := result.(*exec.ExitError)
				wantExit := 126
				if scenario.name == "baseline-printf-refused" {
					// A script exits through set -e; Bash's direct shell tool call exits 126.
					wantExit = 1
				}
				if !ok || exit.ExitCode() != wantExit || !strings.Contains(stderr.String(), "Operation not permitted") {
					t.Fatalf("baseline refusal not confirmed: %v %q", result, stderr.String())
				}
				return
			}
			if result != nil || stdout.String() != root+"\ndiscovery-complete\n" {
				t.Fatalf("launcher failed: %v out=%q err=%q", result, stdout.String(), stderr.String())
			}
		})
		if t.Failed() {
			return
		}
	}
	complete = true
}

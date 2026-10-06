//go:build darwin && farol_native_process

package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// Explicit native policy gate. This invokes the actual compiled Seatbelt plan
// once around /bin/cat and ONLY synthetic files. It is not a production
// Qualification, process lifecycle proof, HOME grant or fallback executor.
func TestNativeSeatbeltCredentialAliases(t *testing.T) {
	base, err := os.MkdirTemp("/private/tmp", "farol-seatbelt-gate-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	root, home := filepath.Join(base, "workspace"), filepath.Join(base, "home")
	for _, path := range []string{root, home} {
		if err = os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	scratch, err := os.MkdirTemp("/private/tmp", "farol-seatbelt-scratch-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(scratch)
	identity := func(path string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10)}
	}
	hash := func(path string) string {
		t.Helper()
		value, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(value)
		return hex.EncodeToString(digest[:])
	}
	allowed, secret, outside := filepath.Join(root, "allowed.txt"), filepath.Join(root, ".env"), filepath.Join(base, "outside.txt")
	for path, value := range map[string]string{
		allowed: "SYNTHETIC_ALLOWED\n", secret: "SYNTHETIC_PROTECTED\n", outside: "SYNTHETIC_OUTSIDE\n",
	} {
		if err = os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	symlink, hardlink := filepath.Join(root, "symbolic-alias.txt"), filepath.Join(root, "hard-alias.txt")
	if err = os.Symlink(secret, symlink); err != nil {
		t.Fatal(err)
	}
	if err = os.Link(secret, hardlink); err != nil {
		t.Fatal(err)
	}
	_, selection, command, evidence := confinementFixture(t)
	selection.Home, selection.Scratch, selection.ScratchIdentity = home, scratch, identity(scratch)
	selection.MechanismSHA256 = hash(seatbeltExecutable)
	selection.Executables = []ExecutablePin{{Path: "/bin/cat", SHA256: hash("/bin/cat")}}
	selection.Snapshot.Participant.Grant.Workspaces[0].Root = root
	workspace := &selection.Snapshot.Approval.Workspaces[0]
	workspace.Root, workspace.RootIdentity = root, identity(root)
	command.Root, command.Cwd, command.RootIdentity = root, root, workspace.RootIdentity
	command.Executable, command.ExecutableSHA256 = "/bin/cat", selection.Executables[0].SHA256
	command.Args = []string{allowed, secret, symlink, hardlink, outside}
	command.Input = nil
	command.Write = false
	selected, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	command.Environment = selected.Environment(false)
	plan, err := compileSeatbelt(selection, command)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	arguments := append(append(append([]string(nil), plan.arguments...), command.Executable), command.Args...)
	child := exec.CommandContext(ctx, seatbeltExecutable, arguments...)
	child.Env, child.Dir = command.Environment, root
	output, runErr := child.CombinedOutput()
	if ctx.Err() != nil || child.ProcessState == nil {
		t.Fatalf("native policy observation unavailable: %v", runErr)
	}
	text := string(output)
	if !strings.Contains(text, "SYNTHETIC_ALLOWED\n") {
		t.Fatalf("native allowed-read baseline failed: exit=%d diagnostic=%s", child.ProcessState.ExitCode(), text)
	}
	if strings.Contains(text, "SYNTHETIC_PROTECTED\n") || strings.Contains(text, "SYNTHETIC_OUTSIDE\n") {
		t.Fatalf("native credential/outside confinement failed: exit=%d diagnostic=%s", child.ProcessState.ExitCode(), text)
	}
	if child.ProcessState.ExitCode() != 1 {
		t.Fatalf("expected cat refusal for protected inputs, got %d", child.ProcessState.ExitCode())
	}
}

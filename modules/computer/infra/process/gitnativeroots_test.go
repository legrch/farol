//go:build darwin && farol_native_root_scoped

package process

import (
	"bytes"
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

// One synthetic coding journey under the actual root-scoped compiler. The
// trusted fixture explicitly approves the Xcode Git installation and a private
// HOME containing only its synthetic Git identity. It never reads the owner's
// HOME/configuration or runs a connector. Root exit and pipe EOF are measured;
// arbitrary descendant settlement and production Qualification remain separate.
func TestNativeRootScopedBashGit(t *testing.T) {
	const gitPath = "/Applications/Xcode.app/Contents/Developer/usr/bin/git"
	const gitRoot = "/Applications/Xcode.app/Contents/Developer/usr"
	base, err := os.MkdirTemp("/private/tmp", "farol-native-git-")
	if err != nil {
		t.Fatal(err)
	}
	scratch, err := os.MkdirTemp("/private/tmp", "farol-git-scratch-")
	if err != nil {
		t.Fatal(err)
	}
	accepted := false
	t.Cleanup(func() {
		if !accepted {
			t.Logf("retain original Git fixture: %s %s; no replay", base, scratch)
			return
		}
		for _, path := range []string{base, scratch} {
			if err := os.RemoveAll(path); err != nil {
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
	identity := func(path string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(path)
		must(err)
		id := info.Sys().(*syscall.Stat_t)
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(id.Dev), 10), Inode: strconv.FormatUint(id.Ino, 10)}
	}
	hash := func(path string) string {
		t.Helper()
		data, err := os.ReadFile(path)
		must(err)
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	root, home, linked := filepath.Join(base, "project"), filepath.Join(base, "home"), filepath.Join(base, "linked")
	for _, dir := range []string{root, home, linked, filepath.Join(root, "template"), filepath.Join(root, "template/hooks")} {
		must(os.Mkdir(dir, 0700))
	}
	write := func(path, content string, mode os.FileMode) {
		t.Helper()
		must(os.WriteFile(path, []byte(content), mode))
	}
	write(filepath.Join(home, ".gitconfig"), "[user]\n\tname = Farol fixture\n\temail = fixture@example.invalid\n[init]\n\ttemplateDir = "+filepath.Join(root, "template")+"\n", 0600)
	write(filepath.Join(root, "template/hooks/pre-commit"), "#!/bin/sh\nset -eu\nproof=$(git rev-parse --git-path hook-proof)\nprintf 'hook-ran\\n' > \"$proof\"\n", 0700)
	write(filepath.Join(root, "source.txt"), "before\n", 0600)
	write(filepath.Join(root, ".env"), "SYNTHETIC_PROJECT_VALUE=local\n", 0600)
	write(filepath.Join(root, "test.sh"), "#!/bin/bash\nset -eu\ntest \"$(cat source.txt)\" = after\nprintf 'test-passed\\n'\n", 0700)
	write(filepath.Join(root, ".gitignore"), "template/\n", 0600)
	s, command := rootScopedFixture(t)
	s.Home, s.Scratch, s.ScratchIdentity = home, scratch, identity(scratch)
	s.MechanismSHA256 = hash(seatbeltExecutable)
	s.Executables = nil
	for _, path := range []string{"/bin/bash", "/bin/sh", "/bin/cat", gitPath} {
		s.Executables = append(s.Executables, ExecutablePin{Path: path, SHA256: hash(path)})
	}
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(root)
	for name, path := range map[string]string{"home": home, "git-tools": gitRoot} {
		addRootScope(&s, name, path, authority.ReadAccess)
		s.Snapshot.Approval.Workspaces[len(s.Snapshot.Approval.Workspaces)-1].RootIdentity = identity(path)
	}
	addRootScope(&s, "linked", linked, authority.WriteAccess)
	s.Snapshot.Approval.Workspaces[len(s.Snapshot.Approval.Workspaces)-1].RootIdentity = identity(linked)
	command.Root, command.Cwd, command.RootIdentity = root, root, identity(root)
	command.Executable, command.ExecutableSHA256 = "/bin/bash", s.Executables[0].SHA256
	const script = `set -eu
git="$1"
linked="$2"
"$git" init -q --initial-branch=fixture
test "$("$git" config --get user.name)" = 'Farol fixture'
printf 'after\n' > source.txt
/bin/bash ./test.sh
"$git" add .gitignore .env source.txt test.sh
"$git" commit -qm 'fixture: verify scoped coding commands'
test "$(cat .git/hook-proof)" = hook-ran
status=$("$git" status --porcelain)
test -z "$status"
printf 'commit='
"$git" rev-parse --verify HEAD
"$git" worktree add -q -b linked "$linked"
printf 'linked change\n' > "$linked/linked-note.txt"
"$git" -C "$linked" add linked-note.txt
"$git" -C "$linked" commit -qm 'fixture: verify linked worktree'
status=$("$git" -C "$linked" status --porcelain)
test -z "$status"
test "$(cat .git/worktrees/linked/hook-proof)" = hook-ran
printf 'linked='
"$git" -C "$linked" rev-parse --verify HEAD
printf 'git-journey-completed\n'
`
	command.Args, command.Input, command.Write = []string{"-c", script, "fixture", gitPath, linked}, nil, true
	command.Environment = seatbeltEnvironment(s, true)
	plan, err := compileSeatbelt(s, command)
	must(err)
	arguments := append(append(append([]string(nil), plan.arguments...), command.Executable), command.Args...)
	child := exec.Command(seatbeltExecutable, arguments...)
	child.Env, child.Dir, child.WaitDelay = command.Environment, root, time.Second
	var out, diagnostic bytes.Buffer
	stdout, stderr := &drainWitness{writer: &out}, &drainWitness{writer: &diagnostic}
	child.Stdout, child.Stderr = stdout, stderr
	must(configure(child))
	must(child.Start())
	t.Logf("one native coding attempt: gitSHA256=%s profileSHA256=%s retainedPID=%d", s.Executables[3].SHA256, plan.digest, child.Process.Pid)
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("original coding child exited unsuccessfully: %v; diagnostic=%s", err, diagnostic.String())
		}
	case <-time.After(15 * time.Second):
		stopErr := child.Process.Kill()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		t.Fatalf("original coding attempt unconfirmed; exact-root stop=%v; retain evidence", stopErr)
	}
	if !stdout.drained() || !stderr.drained() {
		t.Fatal("original output EOF/copies unavailable")
	}
	ref, err := os.ReadFile(filepath.Join(root, ".git/refs/heads/fixture"))
	must(err)
	commit := strings.TrimSpace(string(ref))
	digest, err := hex.DecodeString(commit)
	must(err)
	if len(digest) != 20 && len(digest) != 32 {
		t.Fatal("invalid independently read commit identity")
	}
	linkedRef, err := os.ReadFile(filepath.Join(root, ".git/refs/heads/linked"))
	must(err)
	linkedCommit := strings.TrimSpace(string(linkedRef))
	linkedDigest, err := hex.DecodeString(linkedCommit)
	must(err)
	if len(linkedDigest) != len(digest) || linkedCommit == commit {
		t.Fatal("linked worktree did not produce its independent commit")
	}
	if out.String() != "test-passed\ncommit="+commit+"\nlinked="+linkedCommit+"\ngit-journey-completed\n" {
		t.Fatalf("coding journey did not reach its exact terminal: %q", out.String())
	}
	for path, expected := range map[string]string{"source.txt": "after\n", ".git/hook-proof": "hook-ran\n", ".env": "SYNTHETIC_PROJECT_VALUE=local\n"} {
		data, err := os.ReadFile(filepath.Join(root, path))
		must(err)
		if string(data) != expected {
			t.Fatalf("independent file readback differs: %s", path)
		}
	}
	accepted = true
	t.Logf("Bash edit/test, ordinary Git configuration, hook and local commit passed: %s; no external Shell or arbitrary-tree cleanup claim", commit)
}

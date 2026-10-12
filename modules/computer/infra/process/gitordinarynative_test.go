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

// Select this test explicitly in the native lane. One disposable synthetic
// HOME/repository uses CLT Git through the actual root-scoped compiler, ordinary
// config includes and real template hooks. No owner HOME, config override,
// signing bypass, connector, installed acceptance or process-tree claim.
func TestNativeRootScopedOrdinaryGitWorkflow(t *testing.T) {
	const gitRoot = "/Library/Developer/CommandLineTools"
	const gitPath = gitRoot + "/usr/bin/git"
	base, err := os.MkdirTemp("/private/tmp", "farol-ordinary-git-")
	if err != nil {
		t.Fatal(err)
	}
	accepted := false
	var scratch string
	t.Cleanup(func() {
		if !accepted || t.Failed() {
			t.Logf("retain original ordinary Git fixture: %s %s; no replay", base, scratch)
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
	scratch, err = os.MkdirTemp("/private/tmp", "farol-ordinary-git-scratch-")
	must(err)
	identity := func(path string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(path)
		must(err)
		id, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			t.Fatal("native filesystem identity unavailable")
		}
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(id.Dev), 10), Inode: strconv.FormatUint(id.Ino, 10)}
	}
	hash := func(path string) string {
		t.Helper()
		data, err := os.ReadFile(path)
		must(err)
		sum := sha256.Sum256(data)
		return hex.EncodeToString(sum[:])
	}
	write := func(path, content string, mode os.FileMode) {
		t.Helper()
		must(os.WriteFile(path, []byte(content), mode))
	}
	root, home := filepath.Join(base, "project"), filepath.Join(base, "home")
	template := filepath.Join(home, "template")
	for _, dir := range []string{root, filepath.Join(home, "config"), filepath.Join(template, "hooks")} {
		must(os.MkdirAll(dir, 0700))
	}
	// Git follows the ordinary HOME lookup and relative include resolution.
	// System config is neither replaced nor suppressed; a signing requirement
	// or an ungranted external include must fail this attempt rather than bypass it.
	write(filepath.Join(home, ".gitconfig"), "[include]\n\tpath = config/ordinary.gitconfig\n", 0600)
	write(filepath.Join(home, "config/ordinary.gitconfig"), "[init]\n\tdefaultBranch = fixture\n\ttemplateDir = "+template+"\n[farol]\n\tglobalproof = global-include\n", 0600)
	write(filepath.Join(template, "hooks/pre-commit"), `#!/bin/sh
set -eu
git diff --cached --check
/bin/sh ./test.sh > /dev/null
printf 'pre-commit\n' >> "$(git rev-parse --git-path hook-proof)"
`, 0700)
	write(filepath.Join(template, "hooks/commit-msg"), `#!/bin/sh
set -eu
IFS= read -r subject < "$1"
test "$subject" = 'fixture: ordinary native Git workflow'
printf 'commit-msg\n' >> "$(git rev-parse --git-path hook-proof)"
`, 0700)
	write(filepath.Join(template, "hooks/post-commit"), `#!/bin/sh
set -eu
printf 'post-commit\n' >> "$(git rev-parse --git-path hook-proof)"
`, 0700)
	write(filepath.Join(root, "source.txt"), "before\n", 0600)
	write(filepath.Join(root, "test.sh"), `#!/bin/sh
set -eu
value=$(/bin/cat source.txt)
if test "$value" != after; then
    printf 'project-FAIL\n'
    exit 1
fi
printf 'project-PASS\n'
`, 0700)

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
	for _, grant := range []struct{ name, path string }{{"home", home}, {"clt", gitRoot}} {
		addRootScope(&s, grant.name, grant.path, authority.ReadAccess)
		s.Snapshot.Approval.Workspaces[len(s.Snapshot.Approval.Workspaces)-1].RootIdentity = identity(grant.path)
	}
	command.Root, command.Cwd, command.RootIdentity = root, root, identity(root)
	command.Executable, command.ExecutableSHA256 = "/bin/bash", s.Executables[0].SHA256
	const script = `set -eu
[[ "$PWD" = "$2" && "$HOME" = "$3" && "$TMPDIR" = "$4" ]] || exit 91
git="$1"
"$git" init -q
branch=$("$git" symbolic-ref --short HEAD)
test "$branch" = fixture
global=$("$git" config --show-origin --get farol.globalproof)
test "$global" = "$(printf 'file:%s/config/ordinary.gitconfig\tglobal-include' "$HOME")"
"$git" config --local user.name 'Farol fixture'
"$git" config --local user.email fixture@example.invalid
printf '[farol]\n\trepoproof = repo-include\n' > .git/workflow.config
"$git" config --local include.path workflow.config
repo=$("$git" config --show-origin --get farol.repoproof)
test "$repo" = "$(printf 'file:.git/workflow.config\trepo-include')"
status=$("$git" status --porcelain=v1 --untracked-files=all)
test "$status" = "$(printf '?? source.txt\n?? test.sh')"
"$git" add source.txt test.sh
status=$("$git" status --porcelain=v1)
test "$status" = "$(printf 'A  source.txt\nA  test.sh')"
# Only this expected, deterministic project failure continues. A Git/policy
# refusal, signal or unknown outcome exits the original child without a retry.
if failed=$(/bin/bash ./test.sh); then
    printf 'broken project unexpectedly passed\n' >&2
    exit 92
else
    code=$?
    test "$code" = 1
    test "$failed" = project-FAIL
fi
printf '%s\n' "$failed"
printf 'after\n' > source.txt
status=$("$git" status --porcelain=v1)
test "$status" = "$(printf 'AM source.txt\nA  test.sh')"
diff=$("$git" diff -- source.txt)
case "$diff" in
    *"$(printf '\n-before\n+after')") ;;
    *) printf 'working diff unavailable\n' >&2; exit 93 ;;
esac
printf 'working-diff-verified\n'
/bin/sh ./test.sh
"$git" add source.txt test.sh
staged=$("$git" diff --cached -- source.txt)
case "$staged" in
    *"$(printf '\n+after')") ;;
    *) printf 'staged diff unavailable\n' >&2; exit 94 ;;
esac
printf 'staged-diff-verified\n'
"$git" commit -qm 'fixture: ordinary native Git workflow'
test "$(/bin/cat .git/hook-proof)" = "$(printf 'pre-commit\ncommit-msg\npost-commit')"
status=$("$git" status --porcelain=v1 --untracked-files=all)
test -z "$status"
subject=$("$git" log -1 --format=%s)
test "$subject" = 'fixture: ordinary native Git workflow'
author=$("$git" log -1 --format='%an <%ae>')
test "$author" = 'Farol fixture <fixture@example.invalid>'
printf 'commit='
"$git" log -1 --format=%H
printf 'ordinary-git-workflow-completed\n'
`
	command.Args = []string{"--noprofile", "--norc", "-c", script, "fixture", gitPath, root, home, scratch}
	command.Input, command.Write = nil, true
	command.Environment = seatbeltEnvironment(s, true)
	for _, entry := range command.Environment {
		if strings.HasPrefix(entry, "GIT_CONFIG_") {
			t.Fatal("ordinary Git fixture acquired a config environment override")
		}
	}
	plan, err := compileSeatbelt(s, command)
	must(err)
	if len(plan.roots) != 3 || !hasParameterRule(plan, "allow file-write*", "subpath", root) ||
		!hasParameterRule(plan, "allow file-read*", "subpath", home) ||
		!hasParameterRule(plan, "allow file-read*", "subpath", gitRoot) ||
		hasParameterRule(plan, "allow file-write*", "subpath", home) ||
		hasParameterRule(plan, "allow file-write*", "subpath", gitRoot) ||
		hasParameterRule(plan, "allow file-read*", "subpath", base) || !strings.Contains(plan.source, "(deny network*)") {
		t.Fatal("ordinary Git fixture lost its explicit root/network contract")
	}
	// Private disposable evidence survives any failed or unknown original attempt.
	write(filepath.Join(base, "profile.sb"), plan.source, 0600)
	write(filepath.Join(base, "workflow.bash"), script, 0600)
	arguments := append(append(append([]string(nil), plan.arguments...), command.Executable), command.Args...)
	child := exec.Command(seatbeltExecutable, arguments...)
	child.Env, child.Dir, child.WaitDelay = command.Environment, root, time.Second
	var out, diagnostic ordinaryGitOutput
	stdout, stderr := &drainWitness{writer: &out}, &drainWitness{writer: &diagnostic}
	child.Stdout, child.Stderr = stdout, stderr
	must(configure(child))
	must(child.Start())
	t.Logf("one ordinary Git attempt: tree=%s scratch=%s git=%s gitSHA256=%s mechanismSHA256=%s profileSHA256=%s retainedPID=%d",
		base, scratch, gitPath, s.Executables[3].SHA256, s.MechanismSHA256, plan.digest, child.Process.Pid)
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		write(filepath.Join(base, "stdout.snapshot"), out.String(), 0600)
		write(filepath.Join(base, "stderr.snapshot"), diagnostic.String(), 0600)
		if err != nil {
			t.Fatalf("original ordinary Git child failed: %v; diagnostic=%s", err, diagnostic.String())
		}
	case <-time.After(15 * time.Second):
		// Stop only the exact retained root. No PID/group discovery or replay.
		stopErr := child.Process.Kill()
		select {
		case <-done:
			write(filepath.Join(base, "stdout.snapshot"), out.String(), 0600)
			write(filepath.Join(base, "stderr.snapshot"), diagnostic.String(), 0600)
		case <-time.After(2 * time.Second):
		}
		t.Fatalf("ordinary Git outcome unconfirmed; exact-root stop=%v; retain evidence", stopErr)
	}
	if out.truncated || diagnostic.truncated {
		t.Fatal("ordinary Git output exceeded the bounded snapshot; retain partial evidence")
	}
	if !stdout.drained() || !stderr.drained() {
		t.Fatal("original ordinary Git output EOF/copies unavailable")
	}
	ref, err := os.ReadFile(filepath.Join(root, ".git/refs/heads/fixture"))
	must(err)
	commit := strings.TrimSpace(string(ref))
	digest, err := hex.DecodeString(commit)
	must(err)
	if len(digest) != 20 && len(digest) != 32 {
		t.Fatal("invalid independently read commit identity")
	}
	expected := "project-FAIL\nworking-diff-verified\nproject-PASS\nstaged-diff-verified\ncommit=" + commit + "\nordinary-git-workflow-completed\n"
	if out.String() != expected {
		t.Fatalf("ordinary Git journey did not reach its exact terminal: %q", out.String())
	}
	for path, expected := range map[string]string{
		"source.txt":           "after\n",
		".git/HEAD":            "ref: refs/heads/fixture\n",
		".git/workflow.config": "[farol]\n\trepoproof = repo-include\n",
		".git/hook-proof":      "pre-commit\ncommit-msg\npost-commit\n",
	} {
		data, err := os.ReadFile(filepath.Join(root, path))
		must(err)
		if string(data) != expected {
			t.Fatalf("independent synthetic file readback differs: %s", path)
		}
	}
	for _, name := range []string{"pre-commit", "commit-msg", "post-commit"} {
		path := filepath.Join(root, ".git/hooks", name)
		info, err := os.Lstat(path)
		must(err)
		if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || hash(path) != hash(filepath.Join(template, "hooks", name)) {
			t.Fatalf("actual Git hook differs from executable synthetic template: %s", name)
		}
	}
	accepted = true
	t.Logf("synthetic CLT Git init/status/diff/add/commit/log, config includes, hooks and project FAIL/fix/PASS verified: %s; root exit and EOF only; no installed acceptance or descendant-settlement claim", commit)
}

// Each stream has one os/exec copier. Read only after that original Wait
// returns; truncation preserves bounded partial evidence and never passes.
type ordinaryGitOutput struct {
	bytes.Buffer
	truncated bool
}

func (out *ordinaryGitOutput) Write(data []byte) (int, error) {
	const limit = 64 * 1024
	n := len(data)
	if remaining := limit - out.Len(); len(data) > remaining {
		data = data[:remaining]
		out.truncated = true
	}
	_, _ = out.Buffer.Write(data)
	return n, nil
}

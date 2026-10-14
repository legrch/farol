//go:build darwin && farol_native_root_scoped

package process

import (
	"bytes"
	"context"
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

// Actual CLT data and Seatbelt, using disposable HOME/project only. No extra
// toolchain workspace, system-config override, external MCP or product claim.
func TestNativeCLTGitRuntimeResources(t *testing.T) { nativeCLTGitRuntimeResources(t, false, false) }
func TestNativePinnedPythonGitHooks(t *testing.T)   { nativeCLTGitRuntimeResources(t, true, false) }
func TestNativePinnedPythonGitScopeRefusals(t *testing.T) {
	nativeCLTGitRuntimeResources(t, true, true)
}
func nativeCLTGitRuntimeResources(t *testing.T, python, security bool) {
	raw, err := os.ReadFile("../../../../tooling/shell-platform.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		GitRuntimeResources *GitRuntimeResources
		Executables         []ExecutablePin
	}
	if json.Unmarshal(raw, &declaration) != nil || declaration.GitRuntimeResources == nil {
		t.Fatal("missing checked-in resource declaration")
	}
	r := declaration.GitRuntimeResources
	if !validGitRuntime(r, declaration.Executables) {
		t.Fatal("invalid declared resources")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	for _, pin := range r.resourceFiles() {
		f, err := (nativePlatformFacts{}).gitRuntimeFile(ctx, pin.Path)
		if err != nil || f.sha256 != pin.SHA256 || f.uid != 0 || f.links != 1 {
			t.Fatal("actual data differs", pin.Path, err)
		}
		held, err := (darwinLaunchFilesystem{}).pinGitRuntimeFile(ctx, pin)
		if err != nil {
			if held != nil {
				held.Close()
			}
			t.Fatal("resource retention refused", pin.Path, err)
		}
		defer held.Close()
		if held.recheck(ctx) != nil {
			t.Fatal("original data descriptor changed")
		}
	}
	for _, d := range r.resourceDirectories() {
		f, err := (nativePlatformFacts{}).gitRuntimeDirectory(ctx, d.Path)
		if err != nil || f.entries != strings.Join(d.Entries, "\n") || f.uid != 0 || f.platform.filesystem != "apfs" {
			t.Fatal("actual directory differs", d.Path, err)
		}
	}
	base, err := os.MkdirTemp("/private/tmp", "farol-native-clt-git-")
	if err != nil {
		t.Fatal(err)
	}
	scratch, err := os.MkdirTemp("/private/tmp", "farol-clt-git-scratch-")
	if err != nil {
		t.Fatal(err)
	}
	denied, err := os.MkdirTemp("/private/tmp", "farol-git-denied-")
	if err != nil {
		t.Fatal(err)
	}
	accepted := false
	t.Cleanup(func() {
		if accepted {
			os.RemoveAll(base)
			os.RemoveAll(scratch)
			os.RemoveAll(denied)
		} else {
			t.Logf("retain original fixture: %s %s %s; no replay", base, scratch, denied)
		}
	})
	must := func(e error) {
		t.Helper()
		if e != nil {
			t.Fatal(e)
		}
	}
	identity := func(p string) authority.RootIdentity {
		info, e := os.Lstat(p)
		must(e)
		st := info.Sys().(*syscall.Stat_t)
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}
	}
	hash := func(p string) string {
		b, e := os.ReadFile(p)
		must(e)
		h := sha256.Sum256(b)
		return hex.EncodeToString(h[:])
	}
	project, home, linked := filepath.Join(base, "project"), filepath.Join(base, "home"), filepath.Join(base, "linked")
	for _, p := range []string{project, home, linked, filepath.Join(project, ".git"), filepath.Join(project, ".git/hooks")} {
		must(os.Mkdir(p, 0700))
	}
	must(os.WriteFile(filepath.Join(home, ".gitconfig"), []byte("[user]\n\tname = Farol fixture\n\temail = fixture@example.invalid\n[core]\n\tuntrackedCache = true\n"), 0600))
	must(os.WriteFile(filepath.Join(project, "source.txt"), []byte("fixture\n"), 0600))
	must(os.WriteFile(filepath.Join(project, ".git/hooks/pre-commit"), []byte("#!/bin/sh\nset -eu\nproof=$(git rev-parse --git-path hook-proof)\nprintf 'hook-ran\\n' > \"$proof\"\n"), 0700))
	s, command := rootScopedFixture(t)
	s.Home, s.Scratch, s.ScratchIdentity = home, scratch, identity(scratch)
	s.MechanismSHA256 = hash(seatbeltExecutable)
	s.Executables = []ExecutablePin{{"/bin/bash", hash("/bin/bash")}, {"/bin/sh", hash("/bin/sh")}, {"/bin/cat", hash("/bin/cat")}, r.Git}
	if python {
		s.Executables = declaration.Executables
		must(os.Mkdir(filepath.Join(project, "policies"), 0700))
		must(os.WriteFile(filepath.Join(project, "policies/commit-msg"), []byte(`#!/usr/bin/env python3
import sys
from pathlib import Path
message = Path(sys.argv[1]).read_text().splitlines()[0]
if not message.startswith('fixture: '):
    print('fixture-python-message-rejected', file=sys.stderr)
    raise SystemExit(1)
`), 0700))
		must(os.Symlink("../../policies/commit-msg", filepath.Join(project, ".git/hooks/commit-msg")))
		must(os.WriteFile(filepath.Join(project, ".git/hooks/pre-commit"), []byte(`#!/usr/bin/env python3
import sys, json, hashlib, subprocess
from pathlib import Path
if Path('source.txt').read_text() != 'fixture\n':
    print('fixture-python-pre-commit-rejected', file=sys.stderr)
    raise SystemExit(1)
assert json.loads('{"verified":true}')['verified']
assert hashlib.sha256(b'fixture').hexdigest()
proof = subprocess.check_output(['git','rev-parse','--git-path','hook-proof'], text=True).strip()
Path(proof).write_text('hook-ran\n')
`), 0700))
	} else {
		r = cloneGitRuntime(r)
		r.Python = nil
	}
	s.GitRuntimeResources = r
	s.RootVolumeOnly = true
	s.Snapshot.Participant.Grant.Workspaces[0].Root = base
	s.Snapshot.Approval.Workspaces[0].Root = base
	s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(base)
	command.Root, command.Cwd, command.RootIdentity = base, project, identity(base)
	command.Executable, command.ExecutableSHA256 = "/bin/bash", s.Executables[0].SHA256
	script := "set -eu\ngit=\"$1\"\nlinked=\"$2\"\n\"$git\" init -q\nattributes=$(\"$git\" check-attr diff -- fixture.swift)\ntest \"$attributes\" = \"fixture.swift: diff: swift\"\ntest \"$(\"$git\" config --get init.defaultBranch)\" = main\ntest -f .git/hooks/pre-push.sample\n\"$git\" add source.txt\n\"$git\" commit -qm 'fixture: verify CLT runtime resources'\ntest \"$(cat .git/hook-proof)\" = hook-ran\ntest \"$(\"$git\" log -1 --format=%s)\" = 'fixture: verify CLT runtime resources'\nstatus=$(\"$git\" status --porcelain)\ntest -z \"$status\"\n\"$git\" worktree add -q -b linked \"$linked\"\nprintf 'linked\\n' > \"$linked/linked.txt\"\n\"$git\" -C \"$linked\" add linked.txt\n\"$git\" -C \"$linked\" commit -qm 'fixture: verify CLT linked worktree'\nstatus=$(\"$git\" -C \"$linked\" status --porcelain)\ntest -z \"$status\"\ntest \"$(cat .git/worktrees/linked/hook-proof)\" = hook-ran\nprintf 'git-resource-journey-completed\\n'\n"
	if python {
		script = strings.Replace(script, `"$git" add source.txt`, `"$git" add source.txt policies`, 1)
		negative := `
head=$(git rev-parse HEAD)
if result=$(git commit --allow-empty -qm invalid 2>&1); then exit 71; else test "$?" = 1; fi
test "$result" = fixture-python-message-rejected
test "$(git rev-parse HEAD)" = "$head"
printf 'rejected\n' > source.txt
if result=$(git commit --allow-empty -qm 'fixture: must reject pre-commit' 2>&1); then exit 72; else test "$?" = 1; fi
test "$result" = fixture-python-pre-commit-rejected
test "$(git rev-parse HEAD)" = "$head"
printf 'fixture\n' > source.txt
`
		script = strings.Replace(script, "printf 'git-resource-journey-completed", negative+"\nprintf 'git-resource-journey-completed", 1)
	}
	if security {
		script = strings.Replace(script, `"$git" add source.txt policies`, `"$git" add source.txt policies foreign-hook foreign-interpreter foreign-dependency`, 1)
		must(os.WriteFile(filepath.Join(denied, "canary"), []byte("denied-unchanged\n"), 0600))
		must(os.WriteFile(filepath.Join(denied, "commit-msg"), []byte("#!/bin/sh\nexit 0\n"), 0700))
		image, e := os.ReadFile(pythonRuntimeImage)
		must(e)
		must(os.WriteFile(filepath.Join(denied, "python3"), image, 0700))
		must(os.WriteFile(filepath.Join(denied, "forbidden.py"), []byte("verified=True\n"), 0600))
		must(os.WriteFile(filepath.Join(denied, "config"), []byte("[farol]\n deniedProof = must-not-read\n"), 0600))
		for _, name := range []string{"foreign-hook", "foreign-interpreter", "foreign-dependency"} {
			must(os.Mkdir(filepath.Join(project, name), 0700))
		}
		must(os.Symlink(filepath.Join(denied, "commit-msg"), filepath.Join(project, "foreign-hook/commit-msg")))
		must(os.WriteFile(filepath.Join(project, "foreign-interpreter/commit-msg"), []byte("#!"+filepath.Join(denied, "python3")+"\nraise SystemExit(0)\n"), 0700))
		must(os.WriteFile(filepath.Join(project, "foreign-dependency/commit-msg"), []byte("#!/usr/bin/env python3\nimport sys\nsys.path.insert(0,"+strconv.Quote(denied)+")\nimport forbidden\n"), 0700))
		negative := `
head=$(git rev-parse HEAD)
for hooks in foreign-hook foreign-interpreter foreign-dependency; do
    if result=$("$PWD/$hooks/commit-msg" .git/COMMIT_EDITMSG 2>&1); then exit 73; else code=$?; fi
    if test "$hooks" = foreign-dependency; then test "$code" = 1; else test "$code" = 126; fi
    case "$hooks:$result" in
        foreign-hook:*"Operation not permitted"*|foreign-interpreter:*"Operation not permitted"*|foreign-dependency:*"ModuleNotFoundError"*) ;;
        *) printf '%s\n' "$result" >&2; exit 74 ;;
    esac
    test "$(git rev-parse HEAD)" = "$head"
done
git config --local include.path "$3/config"
if result=$(git config --get farol.deniedProof 2>&1); then exit 75; else test "$?" = 128; fi
case "$result" in *"Operation not permitted"*) ;; *) exit 80;; esac
if result=$(/bin/cat "$3/config" 2>&1); then exit 78; else test "$?" = 1; fi
case "$result" in *"Operation not permitted"*) ;; *) exit 79;; esac
# The rejected include blocks ordinary Git reads too; inspect the owned ref
# directly instead of suppressing configuration to recover a Git command.
test "$(/bin/cat .git/refs/heads/main)" = "$head"
if result=$(/bin/cat "$3/canary" 2>&1); then exit 76; else test "$?" = 1; fi
case "$result" in *"Operation not permitted"*) ;; *) exit 77;; esac
`
		script = strings.Replace(script, "printf 'git-resource-journey-completed", negative+"\nprintf 'git-resource-journey-completed", 1)
	}
	command.Args, command.Write = []string{"-c", script, "fixture", r.Git.Path, linked, denied}, true
	command.Environment = seatbeltEnvironment(s, true)
	plan, err := compileSeatbelt(s, command)
	must(err)
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	must(err)
	bound, err := policy.bind(command)
	must(err)
	launch, err := selectedLaunch(policy, bound)
	must(err)
	measurement, err := retainLaunch(ctx, bound, launch)
	must(err)
	defer measurement.Close()
	must(measurement.Recheck(ctx))
	args := append(append(append([]string(nil), plan.arguments...), command.Executable), command.Args...)
	child := exec.Command(seatbeltExecutable, args...)
	child.Env, child.Dir, child.WaitDelay = command.Environment, project, time.Second
	var stdout, stderr bytes.Buffer
	out, diagnostic := &drainWitness{writer: &stdout}, &drainWitness{writer: &stderr}
	child.Stdout, child.Stderr = out, diagnostic
	must(configure(child))
	must(child.Start())
	t.Logf("one CLT native journey: pid=%d GitSHA256=%s profileSHA256=%s", child.Process.Pid, r.Git.SHA256, plan.digest)
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("original journey failed: %v; stderr=%s", err, stderr.String())
		}
	case <-time.After(25 * time.Second):
		stop := child.Process.Kill()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		t.Fatalf("original child unconfirmed; exact-root stop=%v; retain fixture", stop)
	}
	if !out.drained() || !diagnostic.drained() || stdout.String() != "git-resource-journey-completed\n" || stderr.Len() != 0 {
		t.Fatal("terminal/output mismatch", stdout.String(), stderr.String())
	}
	ref, err := os.ReadFile(filepath.Join(project, ".git/refs/heads/main"))
	must(err)
	linkedRef, err := os.ReadFile(filepath.Join(project, ".git/refs/heads/linked"))
	must(err)
	if len(strings.TrimSpace(string(ref))) != 40 || len(strings.TrimSpace(string(linkedRef))) != 40 || bytes.Equal(ref, linkedRef) {
		t.Fatal("refs did not confirm both commits")
	}
	must(measurement.Recheck(ctx))
	if security {
		actual, err := os.ReadFile(filepath.Join(denied, "canary"))
		must(err)
		if string(actual) != "denied-unchanged\n" {
			t.Fatal("outside canary changed")
		}
		t.Log("direct outside hook symlink/interpreter/dependency execution and configuration/file reads refused; HEAD and canary unchanged; Git skipping inaccessible hooks is not certified")
	}
	accepted = true
	t.Log("actual CLT config/templates, ordinary synthetic HOME config, hooks, init/commit/log/worktree and root/output terminal passed; no live MCP or arbitrary descendant claim")
}

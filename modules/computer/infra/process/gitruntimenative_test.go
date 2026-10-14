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
func TestNativeCLTGitRuntimeResources(t *testing.T) {
	raw, err := os.ReadFile("../../../../tooling/shell-platform.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct{ GitRuntimeResources *GitRuntimeResources }
	if json.Unmarshal(raw, &declaration) != nil || declaration.GitRuntimeResources == nil {
		t.Fatal("missing checked-in resource declaration")
	}
	r := declaration.GitRuntimeResources
	if !validGitRuntime(r, []ExecutablePin{r.Git}) {
		t.Fatal("invalid declared resources")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	for _, pin := range r.Files {
		f, err := (nativePlatformFacts{}).gitRuntimeFile(ctx, pin.Path)
		if err != nil || f.sha256 != pin.SHA256 || f.uid != 0 || f.links != 1 {
			t.Fatal("actual data differs", pin.Path, err)
		}
		held, err := (darwinLaunchFilesystem{}).pinGitRuntimeFile(ctx, pin)
		if err != nil {
			if held != nil {
				held.Close()
			}
			t.Fatal(err)
		}
		defer held.Close()
		if held.recheck(ctx) != nil {
			t.Fatal("original data descriptor changed")
		}
	}
	for _, d := range r.Directories {
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
	accepted := false
	t.Cleanup(func() {
		if accepted {
			os.RemoveAll(base)
			os.RemoveAll(scratch)
		} else {
			t.Logf("retain original fixture: %s %s; no replay", base, scratch)
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
	s.GitRuntimeResources = r
	s.RootVolumeOnly = true
	s.Snapshot.Participant.Grant.Workspaces[0].Root = base
	s.Snapshot.Approval.Workspaces[0].Root = base
	s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(base)
	command.Root, command.Cwd, command.RootIdentity = base, project, identity(base)
	command.Executable, command.ExecutableSHA256 = "/bin/bash", s.Executables[0].SHA256
	const script = "set -eu\ngit=\"$1\"\nlinked=\"$2\"\n\"$git\" init -q\nattributes=$(\"$git\" check-attr diff -- fixture.swift)\ntest \"$attributes\" = \"fixture.swift: diff: swift\"\ntest \"$(\"$git\" config --get init.defaultBranch)\" = main\ntest -f .git/hooks/pre-push.sample\n\"$git\" add source.txt\n\"$git\" commit -qm 'fixture: verify CLT runtime resources'\ntest \"$(cat .git/hook-proof)\" = hook-ran\ntest \"$(\"$git\" log -1 --format=%s)\" = 'fixture: verify CLT runtime resources'\nstatus=$(\"$git\" status --porcelain)\ntest -z \"$status\"\n\"$git\" worktree add -q -b linked \"$linked\"\nprintf 'linked\\n' > \"$linked/linked.txt\"\n\"$git\" -C \"$linked\" add linked.txt\n\"$git\" -C \"$linked\" commit -qm 'fixture: verify CLT linked worktree'\nstatus=$(\"$git\" -C \"$linked\" status --porcelain)\ntest -z \"$status\"\ntest \"$(cat .git/worktrees/linked/hook-proof)\" = hook-ran\nprintf 'git-resource-journey-completed\\n'\n"
	command.Args, command.Write = []string{"-c", script, "fixture", r.Git.Path, linked}, true
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
	accepted = true
	t.Log("actual CLT config/templates, ordinary synthetic HOME config, hooks, init/commit/log/worktree and root/output terminal passed; no live MCP or arbitrary descendant claim")
}

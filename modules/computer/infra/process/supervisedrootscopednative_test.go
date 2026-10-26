//go:build darwin && farol_native_root_scoped && farol_native_process

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// One fresh, disposable compiler/transport witness. The SAME Node resource,
// retained helper/socket, decoder and Child supervise a root-scoped Bash command.
// No public constructor, permissive Qualification, production activation or
// descendant settlement. Select ONLY this test under a fresh native-lane grant;
// never use it to replay TestNativeWatchdogTransport's historical failed attempt.
func TestNativeRootScopedSupervisorBash(t *testing.T) {
	nativeRootScopedSupervisorBash(t, false)
}

// Fresh disposable command: the declared sleep image must run under the actual
// compiler before one cancellation through the retained supervisor. No replay
// of the owner's exited canary or claim about its historical UNKNOWN.
func TestNativeRootScopedPinnedSleepCancellation(t *testing.T) {
	nativeRootScopedSupervisorBash(t, true)
}

func nativeRootScopedSupervisorBash(t *testing.T, cancelSleep bool) {
	selection := nativeWatchdogResource(t) // One explicit pinned resource export.
	base, err := os.MkdirTemp("/private/tmp", "farol-supervised-bash-")
	if err != nil {
		t.Fatal(err)
	}
	accepted := false
	var scratch string
	var f *nativeWatchdogFixture
	t.Cleanup(func() {
		// Registered before nativeWatchdogStart: its exact IPC/Wait cleanup runs
		// first. A partial snapshot is evidence, never completion or permission
		// to signal a PID, retry dispatch, or remove an unresolved synthetic tree.
		if !accepted || t.Failed() {
			if f != nil && f.observed != nil {
				f.observed.mutex.Lock()
				stdout := append([]byte(nil), f.observed.stdout...)
				stderr := append([]byte(nil), f.observed.stderr...)
				f.observed.mutex.Unlock()
				for name, data := range map[string][]byte{"stdout.snapshot": stdout, "stderr.snapshot": stderr} {
					if writeErr := os.WriteFile(filepath.Join(base, name), data, 0600); writeErr != nil {
						t.Error("retain synthetic output snapshot:", writeErr)
					}
				}
				observation, readErr := f.observed.Read(context.Background(), processsvc.Window{})
				if readErr == nil {
					raw, marshalErr := json.MarshalIndent(observation, "", "  ")
					if marshalErr != nil {
						t.Error("encode synthetic observation snapshot:", marshalErr)
					} else if writeErr := os.WriteFile(filepath.Join(base, "observation-snapshot.json"), raw, 0600); writeErr != nil {
						t.Error("retain synthetic observation snapshot:", writeErr)
					}
				} else {
					t.Error("synthetic observation snapshot unavailable:", readErr)
				}
			}
			t.Logf("retain original supervised Bash evidence: %s %s; snapshot may be partial; no replay", base, scratch)
			return
		}
		for _, path := range []string{base, scratch} {
			if err := os.RemoveAll(path); err != nil {
				t.Error("remove exact disposable Bash tree:", err)
			}
		}
	})
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	scratch, err = os.MkdirTemp("/private/tmp", "farol-supervised-bash-scratch-")
	must(err)
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
	root, home := filepath.Join(base, "project"), filepath.Join(base, "home")
	for _, dir := range []string{root, home} {
		must(os.Mkdir(dir, 0700))
	}
	s, command := rootScopedFixture(t)
	s.RootVolumeOnly = true
	s.Home, s.Scratch, s.ScratchIdentity = home, scratch, identity(scratch)
	s.MechanismSHA256 = hash(seatbeltExecutable)
	s.Executables = []ExecutablePin{{Path: "/bin/bash", SHA256: hash("/bin/bash")}}
	if cancelSleep {
		raw, err := os.ReadFile("../../../../tooling/shell-platform.json")
		must(err)
		var declaration struct{ Executables []ExecutablePin }
		must(json.Unmarshal(raw, &declaration))
		found := false
		for _, pin := range declaration.Executables {
			if pin.Path == "/bin/sleep" {
				if pin.SHA256 != hash(pin.Path) {
					t.Fatal("declared sleep image changed")
				}
				s.Executables = append(s.Executables, pin)
				found = true
			}
		}
		if !found {
			t.Fatal("sleep is not a declared executable")
		}
	}
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].RootIdentity = identity(root)
	command.Root, command.Cwd, command.RootIdentity = root, root, identity(root)
	command.Executable, command.ExecutableSHA256 = s.Executables[0].Path, s.Executables[0].SHA256
	// Builtins only, no command descendants or implicit HOME/toolchain grant.
	// Cross both the retained output page and private IPC chunk boundaries;
	// printf emits NUL/non-UTF-8 bytes directly, without Bash variable coercion.
	const script = `set -eu
[[ "$PWD" = "$1" && "$HOME" = "$2" && "$TMPDIR" = "$3" ]] || exit 91
printf 'root-scoped-bash\n'
for ((i=0; i<16385; i++)); do printf '\000\377A\n'; done
printf 'root-scoped-stderr\n\000\377ERR\n' >&2
exit 7
`
	const rootCode = 7
	command.Args = []string{"--noprofile", "--norc", "-c", script, "fixture", root, home, scratch}
	if cancelSleep {
		command.Args = []string{"--noprofile", "--norc", "-c", "set -eu\nsleep 0.01\nprintf 'pinned-sleep-ready\\n'\nexec sleep 10\n"}
	}
	command.Input, command.Write = nil, false
	command.Environment = seatbeltEnvironment(s, false)
	plan, err := compileSeatbelt(s, command)
	must(err)
	if len(plan.roots) != 1 || !hasParameterRule(plan, "allow file-read*", "subpath", root) ||
		hasParameterRule(plan, "allow file-read*", "subpath", home) ||
		hasParameterRule(plan, "allow file-read*", "subpath", base) ||
		hasParameterRule(plan, "allow file-write*", "subpath", root) || !strings.Contains(plan.source, "(deny network*)") {
		t.Fatal("synthetic compiler scope widened or lost network denial")
	}
	wantOut := append([]byte("root-scoped-bash\n"), bytes.Repeat([]byte{0, 255, 'A', '\n'}, 16385)...)
	wantErr := append([]byte("root-scoped-stderr\n"), []byte{0, 255, 'E', 'R', 'R', '\n'}...)
	if cancelSleep {
		wantOut, wantErr = []byte("pinned-sleep-ready\n"), nil
	}
	// All retained files are synthetic. Keep the exact profile and expected
	// bytes outside the command root if an assertion or native outcome is unknown.
	must(os.WriteFile(filepath.Join(base, "profile.sb"), []byte(plan.source), 0600))
	must(os.WriteFile(filepath.Join(base, "stdout.expected"), wantOut, 0600))
	must(os.WriteFile(filepath.Join(base, "stderr.expected"), wantErr, 0600))

	f = nativeWatchdogStart(t, selection) // Existing 12s bound + 2s IPC-only cleanup.
	f.observed.mutex.Lock()
	f.observed.supervisor = processsvc.SupervisorRunning
	f.observed.mutex.Unlock()
	deadline, _ := f.ctx.Deadline()
	args := append(append(append([]string(nil), plan.arguments...), command.Executable), command.Args...)
	prepare := watchdogPrepare{Type: "prepare", ID: f.child.id, Executable: seatbeltExecutable,
		Args: args, Cwd: root, Environment: map[string]string{}, Stdin: "", Deadline: deadline.UnixMilli()}
	for _, entry := range command.Environment {
		name, value, _ := strings.Cut(entry, "=")
		prepare.Environment[name] = value
	}
	rawPrepare, err := json.MarshalIndent(prepare, "", "  ")
	must(err)
	must(os.WriteFile(filepath.Join(base, "prepare-snapshot.json"), rawPrepare, 0600))
	t.Logf("one confined supervised Bash attempt: tree=%s scratch=%s bashSHA256=%s mechanismSHA256=%s profileSHA256=%s helperPID=%d correlation=%s",
		base, scratch, command.ExecutableSHA256, s.MechanismSHA256, plan.digest, f.retained.Pid, f.child.id)
	if err := f.child.send(f.ctx, prepare); err != nil {
		f.fail(t, "single confined prepare write", err)
	}
	if err := f.child.await(f.ctx, f.child.prepared); err != nil {
		f.fail(t, "original confined prepared frame", err)
	}
	if err := f.child.send(f.ctx, watchdogControl{Type: "start", ID: f.child.id}); err != nil {
		f.fail(t, "single confined release", err)
	}
	if err := f.child.await(f.ctx, f.child.ready); err != nil {
		f.fail(t, "original confined ready frame", err)
	}
	if cancelSleep {
		for {
			out, err := f.observed.Read(f.ctx, processsvc.Window{})
			if err != nil || out.Root != processsvc.RootRunning || out.OutputDrained || out.CancelRequested {
				f.fail(t, "original sleep readiness/root unavailable; no cancel", err)
			}
			if bytes.Equal(out.Stdout, wantOut) {
				break
			}
			select {
			case <-f.ctx.Done():
				f.fail(t, "original sleep readiness deadline; no retry", f.ctx.Err())
			case <-time.After(10 * time.Millisecond):
			}
		}
		receipt, err := f.observed.Cancel(f.ctx)
		if err != nil || receipt == nil || receipt.Status != processsvc.CancelRequested || receipt.Handle != f.observed.Handle() {
			f.fail(t, "single original confined cancel ACK unavailable; no retry", err)
		}
	}
	f.settle(t) // Existing exact owning Cmd.Wait witness and decoder/Child closure.
	observation, err := f.observed.Read(context.Background(), processsvc.Window{})
	knownExit := observation.ExitCode != nil && *observation.ExitCode == rootCode && observation.ExitSignal == 0
	if cancelSleep {
		knownExit = observation.ExitCode == nil && observation.ExitSignal == int(syscall.SIGKILL)
	}
	if err != nil || observation.Supervisor != processsvc.SupervisorExited || observation.Root != processsvc.RootExited ||
		!observation.Waited || !knownExit || !observation.OutputDrained || observation.OutputLimitReached ||
		observation.CancelRequested != cancelSleep || observation.TimedOut || observation.AuthorityLost ||
		observation.GroupCleanup != processsvc.CleanupUnverified || observation.DescendantCleanup != processsvc.CleanupUnverified {
		f.fail(t, "known root/supervisor facts unavailable or cleanup overclaimed", err)
	}
	var actual []byte
	for offset := uint64(0); offset < uint64(len(wantOut)); {
		page, err := f.observed.Read(context.Background(), processsvc.Window{StdoutOffset: offset})
		if err != nil || page.StdoutNext <= offset || page.StdoutNext > uint64(len(wantOut)) {
			f.fail(t, "bounded retained output page unavailable", err)
		}
		actual = append(actual, page.Stdout...)
		offset = page.StdoutNext
	}
	if !bytes.Equal(actual, wantOut) || !bytes.Equal(observation.Stderr, wantErr) ||
		observation.StdoutBytes != uint64(len(wantOut)) || observation.StderrBytes != uint64(len(wantErr)) {
		f.fail(t, "original drained binary/text output differs", nil)
	}
	f.child.mutex.Lock()
	closed, uncertain, cohort := f.child.rootClosed, f.child.uncertain, f.child.root.cohort
	f.child.mutex.Unlock()
	if !closed || uncertain || cohort {
		f.fail(t, "original root close unknown or promoted to cohort evidence", nil)
	}
	f.helperExit(t, true) // Exact helper self-SIGKILL; command root independently exited 7.
	if _, err := f.child.Wait(); err == nil || f.witness.calls.Load() != 1 {
		f.fail(t, "repeat decoder Wait reached the original helper", err)
	}
	accepted = true
	t.Log("known root code, drained binary/text output and original supervisor exit; group/descendants unverified; no production qualification")
}

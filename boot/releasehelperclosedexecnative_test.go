//go:build darwin

package boot

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/processprobe"
	"golang.org/x/sys/unix"
)

// This lane runs the REAL compiled `farol run-closed-release-helper` entry as a
// child with the real fd3-6 layout, against disposable REAL app and staged trees
// whose tree digests match the request (the inert oracle images the execution
// package's lifecycle witnesses use). It enables the same declared opt-in as the
// custody lane. Predecessor process, quit state, lease and slot are the same
// disposable inherited-role fixtures; none of them is production role
// authentication, a desktop launch, a package, an installed app or relaunch.

const (
	execNativeSourceDigest = "aa5be957bca1b602513cc520d48ebabb39a79adfffe07ee47434fbc33f4a62bd"
	execNativeTargetDigest = "d0bd0b78217c34f9a0f86dad465ac033ec6a63cd1ba5bdeeffcac545d08bee2d"
	execNativeVersion      = "1.2.3-preview.4"
)

var (
	execNativeBuildOnce sync.Once
	execNativeBinary    string
	execNativeBuildErr  error
)

// execNativeCompiled builds the actual cmd/farol executable once, from the module root.
func execNativeCompiled(t *testing.T) string {
	t.Helper()
	execNativeBuildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "farol-closed-helper-bin-")
		if err != nil {
			execNativeBuildErr = err
			return
		}
		execNativeBinary = filepath.Join(dir, "farol")
		build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", execNativeBinary, "github.com/legrch/farol/cmd/farol")
		build.Dir = ".."
		if out, e := build.CombinedOutput(); e != nil {
			execNativeBuildErr = errors.Join(e, errors.New(string(out)))
		}
	})
	if execNativeBuildErr != nil {
		t.Fatal(execNativeBuildErr)
	}
	return execNativeBinary
}

func execNativeTree(t *testing.T, root, plist string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "Contents", "Resources", "app"), 0700); err != nil {
		t.Fatal(err)
	}
	testdata := filepath.Join("..", "modules", "release", "infra", "native", "appidentity", "testdata")
	for _, document := range []struct{ from, to string }{{plist, "Contents/Info.plist"}, {"oracle.json", "Contents/Resources/app/build-identity.json"}} {
		data, err := os.ReadFile(filepath.Join(testdata, document.from))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(root, document.to), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func execNativeRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func execNativeTestdata(t *testing.T, name string) string {
	t.Helper()
	return execNativeRead(t, filepath.Join("..", "modules", "release", "infra", "native", "appidentity", "testdata", name))
}

type execNativeFixture struct {
	dir, home, update, operation, statePath, leasePath string
	lease                                              *os.File
	leaseID, stateID                                   map[string]any
	predecessorPID                                     int
	processStart, startedAt, quitDigest                string
}

type execNativeOutcome struct {
	ack, stdout, stderr []byte
	exit                int
	cmd                 *exec.Cmd
}

func newExecNativeFixture(t *testing.T, trees bool) *execNativeFixture {
	t.Helper()
	dir, err := os.MkdirTemp("", "farol-closed-helper-exec-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED fixture:", dir)
	if err = os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	f := &execNativeFixture{dir: dir, home: filepath.Join(dir, "home")}
	support := filepath.Join(f.home, "Library", "Application Support", "Farol Next Preview")
	f.statePath = filepath.Join(support, "farol-next-state")
	f.update = filepath.Join(support, "installed-updates")
	f.operation = filepath.Join(f.update, strings.Repeat("1", 32))
	apps := filepath.Join(f.home, "Applications")
	for _, path := range []string{apps, f.statePath, f.operation} {
		if err = os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if trees {
		execNativeTree(t, filepath.Join(apps, "Farol.app"), "oracle.xml")
		execNativeTree(t, filepath.Join(f.operation, "staged.app"), "oracle.bplist")
	}
	state, err := os.Open(f.statePath)
	if err != nil {
		t.Fatal(err)
	}
	f.stateID, err = closedHelperNativeIdentity(state)
	if e := state.Close(); e != nil || err != nil {
		t.Fatal(e, err)
	}
	f.leasePath = filepath.Join(f.statePath, "promotion.lease")
	f.lease, err = os.OpenFile(f.leasePath, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.lease.Close() })
	raw, err := f.lease.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var lockErr error
	if err = raw.Control(func(fd uintptr) { lockErr = unix.Flock(int(fd), unix.LOCK_EX|unix.LOCK_NB) }); err != nil || lockErr != nil {
		t.Fatal(errors.Join(err, lockErr))
	}
	if f.leaseID, err = closedHelperNativeIdentity(f.lease); err != nil {
		t.Fatal(err)
	}
	f.startedAt = time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano)
	predecessor, stop, err := closedHelperNativeStart(t, dir, "predecessor", "predecessor", nil)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := processprobe.New(predecessor.cmd.Process.Pid)
	var observed releaseport.ProcessObservation
	if err == nil {
		observed, err = probe.Observe(context.Background(), time.Now().Add(2*time.Second))
	}
	if err != nil || observed.Presence != releaseport.ProcessPresent || observed.Start == "" {
		_ = stop.Close()
		_ = predecessor.wait(t)
		t.Fatal("predecessor identity unavailable", err)
	}
	// The predecessor has exited (confirmed closed) before any helper starts.
	_ = stop.Close()
	if err = predecessor.wait(t); err != nil {
		t.Fatal(err)
	}
	f.predecessorPID, f.processStart = predecessor.cmd.Process.Pid, observed.Start
	quit := closedHelperJSON(t, map[string]any{"schema": 1, "at": time.Now().UTC().Format(time.RFC3339Nano), "drained": true, "unconfirmed": []string{}})
	if err = os.WriteFile(filepath.Join(f.statePath, "last-quit.json"), quit, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(quit)
	f.quitDigest = hex.EncodeToString(digest[:])
	return f
}

func (f *execNativeFixture) request(action string, relaunch bool) map[string]any {
	request := closedHelperRequestFixture()
	build := strings.Repeat("a", 64)
	request["action"], request["home"], request["relaunch"] = action, f.home, relaunch
	request["source"] = map[string]any{"digest": execNativeSourceDigest, "version": execNativeVersion, "buildId": build}
	request["target"] = map[string]any{"digest": execNativeTargetDigest, "version": execNativeVersion, "buildId": build}
	request["drain"] = map[string]any{"status": "reconciled", "acceptedSource": build, "acceptedTarget": build}
	request["pid"], request["processStart"] = f.predecessorPID, f.processStart
	request["predecessor"] = map[string]any{"kind": "confirmed_closed", "startedAt": f.startedAt, "lastQuitSha256": f.quitDigest, "stateIdentity": f.stateID}
	request["leaseIdentity"] = f.leaseID
	return request
}

// run spawns the real compiled entry with the real fd3-6 layout. When the helper
// is expected to ACK it is released with the correlated continuation; otherwise
// the continuation is never written. The ACK is checked against the protocol's own
// bytes when want is non-empty.
func (f *execNativeFixture) run(t *testing.T, name string, request map[string]any, args ...string) execNativeOutcome {
	t.Helper()
	requestBytes := closedHelperJSON(t, request)
	if request["relaunch"] == false {
		protocol, err := protocolapp.Bind(context.Background(), requestBytes, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
		if err != nil {
			t.Fatal(err)
		}
		slot, err := protocol.BuildSlotBinding(context.Background(), protocolnative.JSONCodec{})
		if err != nil {
			t.Fatal(err)
		}
		slotPath := filepath.Join(f.operation, "slot-binding.json")
		if current, e := os.ReadFile(slotPath); e != nil || !bytes.Equal(current, slot) {
			if err = os.WriteFile(slotPath, slot, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	requestRead, requestWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	ackRead, ackWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	contRead, contWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	c := &closedHelperNativeCommand{name: name, dir: f.dir}
	c.cmd = exec.Command(execNativeCompiled(t), append([]string{closedReleaseHelperCommand}, args...)...)
	c.cmd.ExtraFiles = []*os.File{requestRead, ackWrite, f.lease, contRead}
	c.cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	c.cmd.Dir = "/"
	c.cmd.WaitDelay = time.Second
	c.cmd.Stdout, c.cmd.Stderr = &c.stdout, &c.stderr
	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = c.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = stdin.Close()
	_ = requestRead.Close()
	_ = ackWrite.Close()
	_ = contRead.Close()
	if _, e := requestWrite.Write(requestBytes); e != nil && !errors.Is(e, unix.EPIPE) {
		t.Error(e)
	}
	_ = requestWrite.Close()
	_ = ackRead.SetReadDeadline(time.Now().Add(15 * time.Second))
	ack, readErr := io.ReadAll(io.LimitReader(ackRead, 4097))
	_ = ackRead.Close()
	if readErr != nil {
		t.Error(readErr)
	}
	if len(ack) != 0 {
		if _, e := contWrite.Write(closedHelperJSON(t, closedHelperContinuation(request))); e != nil {
			t.Error(e)
		}
	}
	_ = contWrite.Close()
	waitErr := c.wait(t)
	exit := -1
	if c.cmd.ProcessState != nil {
		exit = c.cmd.ProcessState.ExitCode()
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exitErr) {
		t.Fatal(waitErr)
	}
	return execNativeOutcome{ack: ack, stdout: c.stdout.Bytes(), stderr: c.stderr.Bytes(), exit: exit, cmd: c.cmd}
}

func (f *execNativeFixture) wantACK(t *testing.T, request map[string]any, got []byte) {
	t.Helper()
	protocol, err := protocolapp.Bind(context.Background(), closedHelperJSON(t, request), inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	expected, err := protocol.BuildHandoff(context.Background(), protocolapp.ClosedPredecessorReady, nil)
	if err != nil || !bytes.Equal(got, expected) {
		t.Fatalf("correlated ACK/EOF missing: %q", got)
	}
}

func (f *execNativeFixture) phase(t *testing.T) string {
	t.Helper()
	var journal struct{ Phase string }
	if err := json.Unmarshal([]byte(execNativeRead(t, filepath.Join(f.operation, "journal.json"))), &journal); err != nil {
		t.Fatal(err)
	}
	return journal.Phase
}

func (f *execNativeFixture) exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func (f *execNativeFixture) requireTerminal(t *testing.T, o execNativeOutcome, line string, exit int) {
	t.Helper()
	if o.exit != exit || string(o.stdout) != line || len(o.stderr) != 0 {
		t.Fatalf("exit %d (want %d) stdout %q (want %q) stderr %q", o.exit, exit, o.stdout, line, o.stderr)
	}
	// The executed program is the compiled Go entry itself: no interpreter.
	if o.cmd.Path != execNativeBinary || filepath.Base(o.cmd.Path) != "farol" {
		t.Fatal("helper was not the compiled Go entry", o.cmd.Path)
	}
}

// requireLeaseAndLock proves the parent-owned lease stayed locked and the update
// lock is not left held by the exited helper.
func (f *execNativeFixture) requireLeaseAndLock(t *testing.T, wantUpdateLock bool) {
	t.Helper()
	if err := closedHelperNativeContention(f.leasePath); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(f.update, "lock")
	if !wantUpdateLock {
		if f.exists(lock) {
			t.Fatal("update lock was reached")
		}
		return
	}
	released, err := os.OpenFile(lock, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := released.SyscallConn()
	var flockErr error
	if err == nil {
		err = raw.Control(func(fd uintptr) { flockErr = unix.Flock(int(fd), unix.LOCK_EX|unix.LOCK_NB) })
	}
	if e := released.Close(); err != nil || flockErr != nil || e != nil {
		t.Fatal("update lock still held after helper exit", err, flockErr, e)
	}
}

func execNativeRequire(t *testing.T) {
	t.Helper()
	if os.Getenv(closedHelperNativeEnv) != "1" {
		t.Skip("Root must allocate the native lane explicitly")
	}
}

func TestClosedHelperNativeExecApplyThenRollback(t *testing.T) {
	execNativeRequire(t)
	f := newExecNativeFixture(t, true)
	id := strings.Repeat("1", 32)
	apps := filepath.Join(f.home, "Applications", "Farol.app")

	apply := f.request("apply", false)
	o := f.run(t, "apply", apply)
	f.wantACK(t, apply, o.ack)
	f.requireTerminal(t, o, `{"phase": "verified", "operationId": "`+id+`"}`+"\n", 0)
	if got := f.phase(t); got != "verified" {
		t.Fatal("journal phase", got)
	}
	if execNativeRead(t, filepath.Join(apps, "Contents/Info.plist")) != execNativeTestdata(t, "oracle.bplist") {
		t.Fatal("installed app is not the target")
	}
	if execNativeRead(t, filepath.Join(f.operation, "previous.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") || f.exists(filepath.Join(f.operation, "staged.app")) {
		t.Fatal("previous app not preserved or staged tree remains")
	}
	f.requireLeaseAndLock(t, true)

	rollback := f.request("rollback", false)
	o = f.run(t, "rollback", rollback)
	f.wantACK(t, rollback, o.ack)
	f.requireTerminal(t, o, `{"phase": "rolled_back", "operationId": "`+id+`"}`+"\n", 0)
	if got := f.phase(t); got != "rolled_back" {
		t.Fatal("journal phase", got)
	}
	if execNativeRead(t, filepath.Join(apps, "Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") {
		t.Fatal("installed app is not the source after rollback")
	}
	if execNativeRead(t, filepath.Join(f.operation, "failed.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.bplist") {
		t.Fatal("rolled-back target not retained")
	}
	f.requireLeaseAndLock(t, true)
}

// A pre-ACK refusal: custody passes, then the production readiness finds no
// app/staged tree. The desktop receives the one refused frame (never the ready
// frame), the helper reports the refusal and exits 70 as Python does, and nothing
// is written.
func TestClosedHelperNativeExecPreACKRefusal(t *testing.T) {
	execNativeRequire(t)
	f := newExecNativeFixture(t, false)
	request := f.request("apply", false)
	o := f.run(t, "pre-ack", request)
	if !bytes.Equal(o.ack, wantRefusedFrame(t, closedHelperJSON(t, request), "app_missing")) {
		t.Fatal("pre-ACK refusal did not send exactly the refused frame", o.ack)
	}
	f.requireTerminal(t, o, refusalLine("refused", "app_missing"), 70)
	if f.exists(filepath.Join(f.operation, "journal.json")) {
		t.Fatal("readiness wrote a journal")
	}
	f.requireLeaseAndLock(t, false)
}

// Relaunch is refused before any IO: no ACK, no update lock, no operation ID
// (the request was never trusted past parsing), no journal.
func TestClosedHelperNativeExecRelaunchRefusedBeforeACK(t *testing.T) {
	execNativeRequire(t)
	f := newExecNativeFixture(t, true)
	o := f.run(t, "relaunch", f.request("apply", true))
	if len(o.ack) != 0 {
		t.Fatal("relaunch exposed an ACK", o.ack)
	}
	f.requireTerminal(t, o, "{\"phase\": \"unknown\", \"error\": \"internal\"}\n", 79)
	if f.exists(filepath.Join(f.operation, "journal.json")) || f.exists(filepath.Join(f.operation, "previous.app")) {
		t.Fatal("relaunch refusal reached an effect")
	}
	f.requireLeaseAndLock(t, false)
}

// Extra argv is refused by the dispatcher before any descriptor is read.
func TestClosedHelperNativeExecRefusesExtraArgv(t *testing.T) {
	execNativeRequire(t)
	f := newExecNativeFixture(t, true)
	o := f.run(t, "argv", f.request("apply", false), "--extra")
	if len(o.ack) != 0 || o.exit != 2 || len(o.stdout) != 0 || !strings.Contains(string(o.stderr), closedReleaseHelperCommand) {
		t.Fatalf("extra argv: ack %q exit %d stdout %q stderr %q", o.ack, o.exit, o.stdout, o.stderr)
	}
	if f.exists(filepath.Join(f.operation, "journal.json")) {
		t.Fatal("refused argv reached an effect")
	}
	f.requireLeaseAndLock(t, false)
}

// A staged tree that no longer matches the request digest is refused by the
// production readiness BEFORE the ACK: only the refused frame, exit 70, installed
// app and journal untouched.
func TestClosedHelperNativeExecChangedStagedTree(t *testing.T) {
	execNativeRequire(t)
	f := newExecNativeFixture(t, true)
	if err := os.WriteFile(filepath.Join(f.operation, "staged.app/Contents/Info.plist"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	apply := f.request("apply", false)
	o := f.run(t, "staged-changed", apply)
	if !bytes.Equal(o.ack, wantRefusedFrame(t, closedHelperJSON(t, apply), "digest")) {
		t.Fatal("a changed staged tree was not refused with exactly the refused frame", o.ack)
	}
	f.requireTerminal(t, o, refusalLine("refused", "digest"), 70)
	if f.exists(filepath.Join(f.operation, "journal.json")) {
		t.Fatal("refusal wrote a journal")
	}
	f.requireLeaseAndLock(t, false)
	if execNativeRead(t, filepath.Join(f.home, "Applications", "Farol.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") {
		t.Fatal("installed app changed")
	}
}

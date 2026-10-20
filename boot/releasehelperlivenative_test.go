//go:build darwin

package boot

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/processprobe"
)

// This lane runs the REAL compiled `farol run-live-release-helper` entry as a
// child with the real fd3/fd4 live layout, against disposable REAL app and staged
// trees (the same inert oracle images as the closed lane). The "live app" is a
// scratch /bin/cat this test spawns and terminates by EXACT pid: it is the
// request's predecessor pid and process start, it owns running.json, and its exit
// is what the helper waits for. Nothing here launches Farol, Electron or an
// installed app, and none of it is relaunch, a package or production role
// authentication. Enabled by FAROL_LIVE_HELPER_NATIVE=1 (or the closed lane's
// FAROL_CLOSED_HELPER_NATIVE=1, since both exercise the same helper family).
const liveHelperNativeEnv = "FAROL_LIVE_HELPER_NATIVE"

func liveNativeRequire(t *testing.T) {
	t.Helper()
	if os.Getenv(liveHelperNativeEnv) != "1" && os.Getenv(closedHelperNativeEnv) != "1" {
		t.Skip("Root must allocate the native lane explicitly")
	}
}

type liveNativePredecessor struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	waited  bool
	start   string
	stopped bool
}

// stop ends this exact scratch process: closing its input lets cat exit.
func (p *liveNativePredecessor) stop(t *testing.T) {
	t.Helper()
	if p.stopped {
		return
	}
	p.stopped = true
	_ = p.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = p.cmd.Process.Kill() // The exact retained scratch pid only.
		<-done
		t.Error("scratch predecessor needed a forced kill")
	}
	p.waited = true
}

type liveNativeFixture struct {
	execNativeFixture
	pred     *liveNativePredecessor
	quitHook func()
}

func newLiveNativeFixture(t *testing.T, trees bool) *liveNativeFixture {
	t.Helper()
	dir, err := os.MkdirTemp("", "farol-live-helper-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED fixture:", dir)
	if err = os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	f := &liveNativeFixture{execNativeFixture: execNativeFixture{dir: dir, home: filepath.Join(dir, "home")}}
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
	// The promotion lease exists, mode 0600 and UNLOCKED: a live predecessor
	// holds no lease the helper inherits; the helper takes it after the exit.
	f.leasePath = filepath.Join(f.statePath, "promotion.lease")
	if err = os.WriteFile(f.leasePath, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if f.pred != nil {
			f.pred.stop(t)
		}
	})
	return f
}

// arm spawns the scratch "live app", records its identity and publishes the
// running marker it would own. markerStart overrides the process start written to
// the marker and used by the request, to model a reused or mismatched identity.
func (f *liveNativeFixture) arm(t *testing.T, markerStart string) {
	t.Helper()
	if f.pred != nil {
		f.pred.stop(t)
	}
	cmd := exec.Command("/bin/cat")
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	f.pred = &liveNativePredecessor{cmd: cmd, stdin: stdin}
	probe, err := processprobe.New(cmd.Process.Pid)
	var observed releaseport.ProcessObservation
	if err == nil {
		observed, err = probe.Observe(context.Background(), time.Now().Add(3*time.Second))
	}
	if err != nil || observed.Presence != releaseport.ProcessPresent || observed.Start == "" {
		t.Fatal("scratch predecessor identity unavailable", err)
	}
	f.pred.start = observed.Start
	f.predecessorPID, f.processStart = cmd.Process.Pid, observed.Start
	if markerStart != "" {
		f.processStart = markerStart
	}
	f.startedAt = time.Now().UTC().Add(-2 * time.Second).Format("2006-01-02T15:04:05.000Z")
	marker := closedHelperJSON(t, map[string]any{"schema": 1, "pid": f.predecessorPID, "startedAt": f.startedAt, "bootTime": nil, "processStart": f.processStart})
	_ = os.Remove(filepath.Join(f.statePath, "last-quit.json"))
	if err = os.WriteFile(filepath.Join(f.statePath, "running.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
}

// quit models the desktop's Quit: it exits (exact pid reaped), then publishes the
// confirmed receipt and removes its marker.
func (f *liveNativeFixture) quit(t *testing.T) {
	t.Helper()
	f.pred.stop(t)
	receipt := closedHelperJSON(t, map[string]any{"schema": 1, "at": time.Now().UTC().Format(time.RFC3339Nano), "drained": true, "unconfirmed": []string{}})
	if err := os.WriteFile(filepath.Join(f.statePath, "last-quit.json"), receipt, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.statePath, "running.json")); err != nil {
		t.Fatal(err)
	}
}

func (f *liveNativeFixture) request(action string, relaunch bool) map[string]any {
	request := f.execNativeFixture.request(action, relaunch)
	delete(request, "predecessor")
	delete(request, "leaseIdentity")
	request["waitSeconds"] = 3
	return request
}

type liveNativeOutcome struct {
	execNativeOutcome
	waitingFrame bool
}

// run spawns the real compiled live entry with the fd3/fd4 layout. After the
// waiting_for_exit frame arrives, quit (when set) is performed by this test.
func (f *liveNativeFixture) run(t *testing.T, request map[string]any, quit bool, args ...string) liveNativeOutcome {
	t.Helper()
	requestBytes := closedHelperJSON(t, request)
	if request["relaunch"] == false && request["action"] != "recover" {
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
	c := &closedHelperNativeCommand{name: "live-helper", dir: f.dir}
	c.cmd = exec.Command(execNativeCompiled(t), append([]string{liveReleaseHelperCommand}, args...)...)
	c.cmd.ExtraFiles = []*os.File{requestRead, ackWrite}
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
	if _, e := requestWrite.Write(requestBytes); e != nil && !errors.Is(e, os.ErrClosed) {
		t.Log("request write:", e)
	}
	_ = requestWrite.Close()
	_ = ackRead.SetReadDeadline(time.Now().Add(15 * time.Second))
	ack, readErr := io.ReadAll(io.LimitReader(ackRead, 4097))
	_ = ackRead.Close()
	if readErr != nil {
		t.Error(readErr)
	}
	// The frame seals with EOF; only then does the desktop quit.
	if len(ack) != 0 && quit {
		if f.quitHook != nil {
			f.quitHook()
		} else {
			f.quit(t)
		}
	}
	waitErr := c.wait(t)
	exit := -1
	if c.cmd.ProcessState != nil {
		exit = c.cmd.ProcessState.ExitCode()
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exitErr) {
		t.Fatal(waitErr)
	}
	return liveNativeOutcome{execNativeOutcome: execNativeOutcome{ack: ack, stdout: c.stdout.Bytes(), stderr: c.stderr.Bytes(), exit: exit, cmd: c.cmd}, waitingFrame: len(ack) != 0}
}

func (f *liveNativeFixture) wantWaitingFrame(t *testing.T, request map[string]any, got []byte) {
	t.Helper()
	protocol, err := protocolapp.Bind(context.Background(), closedHelperJSON(t, request), inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	expected, err := protocol.BuildHandoff(context.Background(), protocolapp.WaitingForExit, nil)
	if err != nil || !bytes.Equal(got, expected) {
		t.Fatalf("waiting_for_exit frame missing or wrong: %q", got)
	}
}

func (f *liveNativeFixture) noEffect(t *testing.T) {
	t.Helper()
	for _, name := range []string{"journal.json", "previous.app", "failed.app"} {
		if f.exists(filepath.Join(f.operation, name)) {
			t.Fatal("refused run reached an effect:", name)
		}
	}
}

func TestLiveHelperNativeApplyThenRollback(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	id := strings.Repeat("1", 32)
	apps := filepath.Join(f.home, "Applications", "Farol.app")

	f.arm(t, "")
	apply := f.request("apply", false)
	o := f.run(t, apply, true)
	f.wantWaitingFrame(t, apply, o.ack)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "verified", "operationId": "`+id+`"}`+"\n", 0)
	if got := f.phase(t); got != "verified" {
		t.Fatal("journal phase", got)
	}
	if execNativeRead(t, filepath.Join(apps, "Contents/Info.plist")) != execNativeTestdata(t, "oracle.bplist") {
		t.Fatal("installed app is not the target")
	}
	if execNativeRead(t, filepath.Join(f.operation, "previous.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") || f.exists(filepath.Join(f.operation, "staged.app")) {
		t.Fatal("previous app not preserved or staged tree remains")
	}
	if f.pred.waited != true {
		t.Fatal("the scratch predecessor was not the process that exited")
	}
	// The helper process has exited: it holds neither the update lock nor the lease.
	if err := closedHelperNativeContention(filepath.Join(f.update, "lock")); err == nil {
		t.Fatal("update lock still held after the helper exited")
	}

	// Rollback: a fresh scratch "live app" (the target now running).
	f.arm(t, "")
	rollback := f.request("rollback", false)
	o = f.run(t, rollback, true)
	f.wantWaitingFrame(t, rollback, o.ack)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "rolled_back", "operationId": "`+id+`"}`+"\n", 0)
	if got := f.phase(t); got != "rolled_back" {
		t.Fatal("journal phase", got)
	}
	if execNativeRead(t, filepath.Join(apps, "Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") {
		t.Fatal("installed app is not the source after rollback")
	}
	if execNativeRead(t, filepath.Join(f.operation, "failed.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.bplist") {
		t.Fatal("rolled-back target not retained")
	}
}

// The predecessor never exits inside the bound: the frame was sent, so the
// outcome is unknown (79), but nothing was written, no journal exists and the
// installed app is untouched.
func TestLiveHelperNativeNeverExitsIsUnknownWithoutEffect(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	request := f.request("apply", false)
	request["waitSeconds"] = 2
	started := time.Now()
	o := f.run(t, request, false)
	elapsed := time.Since(started)
	f.wantWaitingFrame(t, request, o.ack)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "unknown", "error": "internal", "operationId": "`+strings.Repeat("1", 32)+`"}`+"\n", 79)
	f.noEffect(t)
	if elapsed < 2*time.Second || elapsed > 12*time.Second {
		t.Fatalf("wait bound not honoured: %v", elapsed)
	}
	if execNativeRead(t, filepath.Join(f.home, "Applications", "Farol.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") {
		t.Fatal("installed app changed")
	}
	if err := f.pred.cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("the helper must not signal or reap the predecessor", err)
	}
}

// A start that differs from the observed process (a reused pid) is refused BEFORE
// the desktop is told to exit: no frame at all, no effect. The marker and request
// agree on the bogus start so only the live identity witness can refuse it.
func TestLiveHelperNativeWrongProcessStartIsRefusedBeforeTheFrame(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "Thu Jan  1 00:00:00 1970")
	o := f.run(t, f.request("apply", false), true)
	if o.waitingFrame {
		t.Fatalf("a mismatched process identity was acknowledged: %q", o.ack)
	}
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "unknown", "error": "internal", "operationId": "`+strings.Repeat("1", 32)+`"}`+"\n", 79)
	f.noEffect(t)
}

// A marker that does not belong to the request's pid/start is refused at capture.
func TestLiveHelperNativeForeignMarkerIsRefusedBeforeTheFrame(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	request := f.request("apply", false)
	request["processStart"] = "Thu Jan  1 00:00:00 1970"
	o := f.run(t, request, true)
	if o.waitingFrame || o.exit != 79 {
		t.Fatalf("foreign marker: ack %q exit %d", o.ack, o.exit)
	}
	f.noEffect(t)
}

// A Quit that was never confirmed (no receipt) after the exit is no proof.
func TestLiveHelperNativeMissingQuitReceiptIsRefused(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	apply := f.request("apply", false)
	// The process exits and its marker vanishes, but NO last-quit.json is published.
	f.quitHook = func() {
		f.pred.stop(t)
		if err := os.Remove(filepath.Join(f.statePath, "running.json")); err != nil {
			t.Error(err)
		}
	}
	o := f.run(t, apply, true)
	f.wantWaitingFrame(t, apply, o.ack)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "unknown", "error": "internal", "operationId": "`+strings.Repeat("1", 32)+`"}`+"\n", 79)
	f.noEffect(t)
}

// Relaunch and recover are later packets: refused before any IO, no frame, no
// update lock, no operation ID.
func TestLiveHelperNativeRelaunchAndRecoverRefusedBeforeAnyEffect(t *testing.T) {
	liveNativeRequire(t)
	for name, mutate := range map[string]func(map[string]any){
		"relaunch": func(r map[string]any) { r["relaunch"] = true },
		"recover":  func(r map[string]any) { r["action"] = "recover" },
	} {
		t.Run(name, func(t *testing.T) {
			f := newLiveNativeFixture(t, true)
			f.arm(t, "")
			request := f.request("apply", false)
			mutate(request)
			o := f.run(t, request, true)
			if o.waitingFrame {
				t.Fatal("refused request exposed a frame", o.ack)
			}
			f.requireTerminal(t, o.execNativeOutcome, "{\"phase\": \"unknown\", \"error\": \"internal\"}\n", 79)
			f.noEffect(t)
			if f.exists(filepath.Join(f.update, "lock")) {
				t.Fatal("refused request reached the update lock")
			}
			if err := f.pred.cmd.Process.Signal(syscall.Signal(0)); err != nil {
				t.Fatal("predecessor was disturbed", err)
			}
		})
	}
}

// A missing app/staged tree is refused by the production readiness BEFORE the
// frame: nothing is exposed, nothing written. The update lock was already taken
// (Python takes it for a live predecessor before readiness) and is released.
func TestLiveHelperNativeReadinessRefusalPrecedesTheFrame(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, false)
	f.arm(t, "")
	o := f.run(t, f.request("apply", false), true)
	if o.waitingFrame {
		t.Fatal("pre-ACK refusal exposed a frame", o.ack)
	}
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "unknown", "error": "internal", "operationId": "`+strings.Repeat("1", 32)+`"}`+"\n", 79)
	f.noEffect(t)
	if err := f.pred.cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("predecessor was disturbed", err)
	}
}

func TestLiveHelperNativeRefusesExtraArgv(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	o := f.run(t, f.request("apply", false), true, "--extra")
	if o.waitingFrame || o.exit != 2 || len(o.stdout) != 0 || !strings.Contains(string(o.stderr), liveReleaseHelperCommand) {
		t.Fatalf("extra argv: ack %q exit %d stdout %q stderr %q", o.ack, o.exit, o.stdout, o.stderr)
	}
	f.noEffect(t)
}

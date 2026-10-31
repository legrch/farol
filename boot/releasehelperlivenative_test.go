//go:build darwin

package boot

import (
	"bytes"
	"context"
	"encoding/json"
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
	pred         *liveNativePredecessor
	quitHook     func()
	dropObserver bool
}

func newLiveNativeFixture(t *testing.T, trees bool) *liveNativeFixture {
	t.Helper()
	parent, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(parent, "farol-live-helper-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED fixture:", dir)
	if err = os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	f := &liveNativeFixture{execNativeFixture: execNativeFixture{dir: dir, home: filepath.Join(dir, "home")}}
	support := filepath.Join(f.home, "Library", "Application Support", "io.github.legrch.farol")
	f.statePath = filepath.Join(support, "farol-state")
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
	cmd := exec.Command("/bin/cat")
	cmd.Dir = "/"
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	f.armCommand(t, markerStart, cmd)
}

func (f *liveNativeFixture) armCommand(t *testing.T, markerStart string, cmd *exec.Cmd) {
	t.Helper()
	if f.pred != nil {
		f.pred.stop(t)
	}
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
	// Like the desktop (main.ts), publish the receipt and remove the marker while
	// the process is still alive, and only THEN let that exact process exit. The
	// helper can observe the exit at any instant, so it must already find a
	// finished Quit state.
	receipt := closedHelperJSON(t, map[string]any{"schema": 1, "at": time.Now().UTC().Format(time.RFC3339Nano), "drained": true, "unconfirmed": []string{}})
	if err := os.WriteFile(filepath.Join(f.statePath, "last-quit.json"), receipt, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.statePath, "running.json")); err != nil {
		t.Fatal(err)
	}
	f.pred.stop(t)
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
	// Successful relaunch belongs to execution's replaced-open seam. Compiled
	// recovery refusal fixtures may request it only while the predecessor stays
	// alive; an unexpected ready frame is killed below before Quit.
	if request["relaunch"] == true && request["action"] != "recover" {
		t.Fatal("compiled fixture must not dispatch LaunchServices")
	}
	requestBytes := closedHelperJSON(t, request)
	// Offline recover is refused before any slot binding exists, so the test must
	// not manufacture one (BuildSlotBinding is a recover-with-relaunch protocol).
	if request["action"] != "recover" || request["relaunch"] == true {
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
	var observerRead, observerWrite *os.File
	if f.dropObserver {
		observerRead, observerWrite, err = os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		defer observerRead.Close()
		defer observerWrite.Close()
		c.cmd.Stdout = observerWrite
		c.cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = c.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if observerWrite != nil {
		_ = observerWrite.Close()
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
	// The waiting_for_exit frame seals with EOF; only then does the desktop quit.
	// A refused frame keeps the desktop running (installed-update-helper.ts).
	waiting := bytes.Contains(ack, []byte(`"phase":"`+protocolapp.WaitingForExit+`"`))
	if waiting && request["relaunch"] == true {
		_ = c.cmd.Process.Kill() // This exact test-owned helper, still waiting on our live predecessor.
		_ = c.wait(t)
		t.Fatal("relaunch refusal fixture unexpectedly admitted Quit")
	}
	if waiting && quit {
		if observerRead != nil {
			_ = observerRead.Close()
		}
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
	return liveNativeOutcome{execNativeOutcome: execNativeOutcome{ack: ack, stdout: c.stdout.Bytes(), stderr: c.stderr.Bytes(), exit: exit, cmd: c.cmd}, waitingFrame: waiting}
}

// Losing the original desktop's terminal reader must not cancel an admitted
// update. This uses a disposable predecessor and a detached native helper; it
// does not qualify LaunchServices or the shared /Applications slot.
func TestLiveHelperNativeApplySurvivesClosedObserver(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.dropObserver = true
	f.arm(t, "")
	request := f.request("apply", false)
	o := f.run(t, request, true)
	f.wantWaitingFrame(t, request, o.ack)
	if o.exit != 0 || f.phase(t) != "verified" {
		t.Fatalf("detached update did not survive its observer: exit=%d phase=%s stderr=%s", o.exit, f.phase(t), o.stderr)
	}
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

// wantRefusal asserts the Python-parity pre-ACK refusal: exactly one refused
// handoff frame for this request (never waiting_for_exit), then the refusal line
// and exit 70.
func (f *liveNativeFixture) wantRefusal(t *testing.T, request map[string]any, o liveNativeOutcome, phase, code string) {
	t.Helper()
	if !bytes.Equal(o.ack, wantRefusedFrame(t, closedHelperJSON(t, request), code)) {
		t.Fatalf("refused frame missing or wrong: %q", o.ack)
	}
	f.requireTerminal(t, o.execNativeOutcome, refusalLine(phase, code), 70)
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

// There is deliberately no successful relaunch witness on the compiled
// entry. With the production /usr/bin/open the only seam, a relaunch here would
// run LaunchServices over a disposable inert image that carries the production
// bundle id: it registers that temporary path with the owner's LaunchServices and
// can collide with the owner's Farol. The launch is exercised with a replaced
// open in modules/release/infra/native/execution (deterministic Milestone tests
// and FAROL_RELAUNCH_NATIVE=1), and the terminal line and exit code of every
// result in the boot terminal-mapping tests.

// The real self measurement: this very process, through the native probe and the
// process-wait policy, equal to an independent observation, and joined.
func TestLiveHelperNativeMeasuresThisProcess(t *testing.T) {
	liveNativeRequire(t)
	until := time.Now().Add(5 * time.Second)
	self, err := liveHelperMeasureSelf(context.Background(), until)
	if err != nil || self.PID != int64(os.Getpid()) || self.ProcessStart == "" {
		t.Fatal("measurement", self, err)
	}
	probe, err := processprobe.New(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	observed, err := probe.Observe(context.Background(), until)
	if err != nil || probe.Join() != nil || observed.Presence != releaseport.ProcessPresent || observed.Start != self.ProcessStart {
		t.Fatalf("independent observation %+v (%v) differs from %+v", observed, err, self)
	}
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	if again, err := liveHelperMeasureSelf(expired, until); err == nil || again != (releaseport.HelperSelfIdentity{}) {
		t.Fatal("a canceled measurement produced an identity", again, err)
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
// the desktop is told to exit: the desktop receives only the refused frame (as
// from Python), the helper exits 70 and nothing is written. The marker and
// request agree on the bogus start so only the live identity witness can refuse it.
func TestLiveHelperNativeWrongProcessStartIsRefusedBeforeTheFrame(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "Thu Jan  1 00:00:00 1970")
	request := f.request("apply", false)
	o := f.run(t, request, true)
	f.wantRefusal(t, request, o, "refused", "process_identity")
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
	f.wantRefusal(t, request, o, "refused", "run_marker_mismatch")
	f.noEffect(t)
}

// An observed exit permits update without a Quit receipt; the log retains the note.
func TestLiveHelperNativeMissingQuitReceiptUpdatesWithDiagnostic(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	apply := f.request("apply", false)
	// The marker vanishes while the process is alive and the process then exits,
	// but NO last-quit.json is published. Neither a clean receipt nor marker
	// removal grants the observed exit; the helper must wait for the process.
	f.quitHook = func() {
		if err := os.Remove(filepath.Join(f.statePath, "running.json")); err != nil {
			t.Error(err)
		}
		f.pred.stop(t)
	}
	o := f.run(t, apply, true)
	f.wantWaitingFrame(t, apply, o.ack)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "verified", "operationId": "`+strings.Repeat("1", 32)+`"}`+"\n", 0)
	if got := f.phase(t); got != "verified" {
		t.Fatal("journal phase", got)
	}
	if execNativeRead(t, filepath.Join(f.home, "Applications/Farol.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.bplist") {
		t.Fatal("missing receipt prevented target installation")
	}
	log := execNativeRead(t, filepath.Join(f.operation, "helper.log.jsonl"))
	if !strings.Contains(log, `"code":"predecessor_drain_unconfirmed"`) {
		t.Fatal("missing drain diagnostic", log)
	}
	journal := execNativeRead(t, filepath.Join(f.operation, "journal.json"))
	if strings.Contains(journal, `"note"`) {
		t.Fatal("diagnostic broke predecessor journal compatibility", journal)
	}
}

// Offline recover (relaunch false) has no production caller: refused before any IO,
// no frame, no update lock, no operation ID.
func TestLiveHelperNativeOfflineRecoverRefusedBeforeAnyEffect(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	request := f.request("recover", false)
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
}

// Recover WITH relaunch on the real compiled entry and real owners. With no
// operation journal the production readiness (the recovery Inspect lane) refuses
// BEFORE the frame: only the refused frame is sent, nothing is written and the
// desktop is not told to quit.
func TestLiveHelperNativeRecoverWithoutAJournalIsRefusedBeforeTheFrame(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	request := f.request("recover", true)
	o := f.run(t, request, true)
	if o.waitingFrame {
		t.Fatal("a recovery without a journal exposed waiting_for_exit", o.ack)
	}
	f.wantRefusal(t, request, o, "refused", "journal_invalid")
	f.noEffect(t)
	if err := f.pred.cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("predecessor was disturbed", err)
	}
}

// A REAL prepared journal whose only entry is the original app (staged, previous
// and failed all absent) matches no recovery pair. The clean `recovery_pair`
// refusal comes from the original recovery owner's own Failure type, through the
// production readiness scope: ONE refused frame (never waiting_for_exit), phase
// and code from the owner, exit 70, and nothing is written. The journal is
// constructed from a real apply by restoring the source app and rewinding its phase.
func TestLiveHelperNativeRecoverUnrecognisedPairIsRefusedWithTheOwnersCode(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	id := strings.Repeat("1", 32)
	apps := filepath.Join(f.home, "Applications", "Farol.app")
	f.arm(t, "")
	o := f.run(t, f.request("apply", false), true)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "verified", "operationId": "`+id+`"}`+"\n", 0)
	if err := os.RemoveAll(apps); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.operation, "previous.app"), apps); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(f.operation, "journal.json")
	rewound := strings.Replace(execNativeRead(t, journalPath), `"phase":"verified"`, `"phase":"prepared"`, 1)
	if err := os.WriteFile(journalPath, []byte(rewound), 0600); err != nil {
		t.Fatal(err)
	}
	if got := f.phase(t); got != "prepared" {
		t.Fatal("journal phase", got)
	}

	f.arm(t, "")
	request := f.request("recover", true)
	o = f.run(t, request, true)
	if o.waitingFrame {
		t.Fatal("an unrecognised pair exposed waiting_for_exit", o.ack)
	}
	f.wantRefusal(t, request, o, "prepared", "recovery_pair")
	if got := f.phase(t); got != "prepared" || f.exists(filepath.Join(f.operation, "previous.app")) || f.exists(filepath.Join(f.operation, "failed.app")) {
		t.Fatal("a refused recovery wrote an effect", got)
	}
	if execNativeRead(t, filepath.Join(apps, "Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") {
		t.Fatal("installed app changed")
	}
	if err := f.pred.cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatal("predecessor was disturbed", err)
	}
}

// A missing app/staged tree is refused by the production readiness BEFORE the
// waiting_for_exit frame: only the refused frame is sent, nothing is written. The update lock was already taken
// (Python takes it for a live predecessor before readiness) and is released.
func TestLiveHelperNativeReadinessRefusalPrecedesTheFrame(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, false)
	f.arm(t, "")
	request := f.request("apply", false)
	o := f.run(t, request, true)
	f.wantRefusal(t, request, o, "refused", "app_missing")
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

// A successor marker present when the helper observes predecessor exit must
// stop the real compiled helper before any journal or bundle mutation.
func TestLiveHelperNativeSuccessorMarkerRefusesBeforeMutation(t *testing.T) {
	liveNativeRequire(t)
	f := newLiveNativeFixture(t, true)
	f.arm(t, "")
	apply := f.request("apply", false)
	self, err := liveHelperMeasureSelf(context.Background(), time.Now().Add(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	// Publish before stopping the predecessor so the helper cannot race ahead of
	// this deterministic successor/startup interleaving.
	f.quitHook = func() {
		marker := closedHelperJSON(t, map[string]any{"schema": 1, "pid": self.PID, "processStart": self.ProcessStart, "startedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "bootTime": nil})
		if err := os.WriteFile(filepath.Join(f.statePath, "running.json"), marker, 0600); err != nil {
			t.Fatal(err)
		}
		f.pred.stop(t)
	}
	o := f.run(t, apply, true)
	f.wantWaitingFrame(t, apply, o.ack)
	f.requireTerminal(t, o.execNativeOutcome, `{"phase": "unknown", "error": "internal", "operationId": "`+strings.Repeat("1", 32)+`"}`+"\n", 79)
	f.noEffect(t)
	if execNativeRead(t, filepath.Join(f.home, "Applications/Farol.app/Contents/Info.plist")) != execNativeTestdata(t, "oracle.xml") {
		t.Fatal("successor bundle was replaced")
	}
}

// Real Electron creates the detached helper, then quits after the original ACK.
// No windows, account, owner profile, shared slot or LaunchServices participates.
func TestLiveHelperNativeApplyAfterElectronQuit(t *testing.T) {
	liveNativeRequire(t)
	electron := os.Getenv("FAROL_TEST_HELPER_ELECTRON")
	if !filepath.IsAbs(electron) {
		t.Skip("explicit reviewed Electron required")
	}
	f := newLiveNativeFixture(t, true)
	t.Cleanup(func() {
		if f.pred != nil {
			f.pred.stop(t)
		}
		data, err := os.ReadFile(filepath.Join(f.dir, "helper-pid.json"))
		if errors.Is(err, os.ErrNotExist) {
			return // No recorded spawn; the predecessor has been joined.
		}
		var identity struct {
			PID   int    `json:"pid"`
			Start string `json:"start"`
		}
		if err != nil || json.Unmarshal(data, &identity) != nil || identity.Start == "" {
			t.Error("detached fixture helper identity unavailable; retain evidence")
			return
		}
		probe, err := processprobe.New(identity.PID)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() {
			if err := probe.Join(); err != nil {
				t.Error(err)
			}
		}()
		until := time.Now().Add(5 * time.Second)
		stopped := false
		for {
			observed, err := probe.Observe(context.Background(), time.Now().Add(time.Second))
			if err != nil {
				t.Error("detached helper cleanup unconfirmed", err)
				return
			}
			if observed.Presence == releaseport.ProcessAbsent {
				return
			}
			if observed.Presence != releaseport.ProcessPresent || observed.Start != identity.Start {
				t.Error("detached helper identity changed; refusing termination")
				return
			}
			if time.Now().After(until) {
				if stopped {
					t.Error("detached helper termination unconfirmed")
					return
				}
				// Only the original spawn and its matching start token qualify.
				if err := syscall.Kill(identity.PID, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
					t.Error(err)
					return
				}
				t.Error("detached fixture helper required forced termination")
				stopped = true
				until = time.Now().Add(3 * time.Second)
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
	script := filepath.Join(f.dir, "electron-helper.cjs")
	const source = `const {app}=require('electron');
const fs=require('node:fs'); const path=require('node:path'); const {spawn,execFileSync}=require('node:child_process');
const root=process.argv[2]; app.setPath('userData',path.join(root,'electron-profile'));
app.whenReady().then(()=>{app.dock?.hide(); let input='';
process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{input+=chunk; if(!input.includes('\n')) return;
process.stdin.removeAllListeners('data'); const plan=JSON.parse(input);
const out=fs.openSync(path.join(root,'terminal.json'),'wx',0o600);
const err=fs.openSync(path.join(root,'stderr.log'),'wx',0o600);
const child=spawn(plan.binary,['run-live-release-helper'],{cwd:'/',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},detached:true,stdio:['ignore',out,err,'pipe','pipe']});
fs.closeSync(out); fs.closeSync(err); child.unref();
const identityFile=path.join(root,'helper-pid.json');
fs.writeFileSync(identityFile,JSON.stringify({pid:child.pid,start:''}),{mode:0o600});
const start=execFileSync('/bin/ps',['-p',String(child.pid),'-o','lstart='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}).trim();
fs.writeFileSync(identityFile,JSON.stringify({pid:child.pid,start}),{mode:0o600});
child.stdio[3].end(JSON.stringify(plan.request)+'\n'); let ack='';
child.stdio[4].on('data',chunk=>{ack+=chunk;}); child.stdio[4].on('end',()=>{
fs.writeFileSync(path.join(root,'ack.json'),ack,{mode:0o600});
fs.writeFileSync(path.join(plan.state,'last-quit.json'),JSON.stringify({schema:1,at:new Date().toISOString(),drained:true,unconfirmed:[]}),{mode:0o600});
fs.unlinkSync(path.join(plan.state,'running.json')); app.quit();});
}); process.stdin.on('end',()=>app.quit());});`
	if err := os.WriteFile(script, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(electron, script, f.dir)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	cmd.Dir = "/"
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	f.armCommand(t, "", cmd)
	request := f.request("apply", false)
	request["waitSeconds"] = 10
	protocol, err := protocolapp.Bind(context.Background(), closedHelperJSON(t, request), inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	slot, err := protocol.BuildSlotBinding(context.Background(), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.operation, "slot-binding.json"), slot, 0600); err != nil {
		t.Fatal(err)
	}
	plan := closedHelperJSON(t, map[string]any{"binary": execNativeCompiled(t), "request": request, "state": f.statePath})
	if _, err = f.pred.stdin.Write(append(plan, '\n')); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	var ack []byte
	for time.Now().Before(deadline) {
		ack, err = os.ReadFile(filepath.Join(f.dir, "ack.json"))
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("Electron ACK missing: %v %s", err, stderr.String())
	}
	f.wantWaitingFrame(t, request, ack)
	f.pred.stop(t)
	for time.Now().Before(deadline) {
		terminal, _ := os.ReadFile(filepath.Join(f.dir, "terminal.json"))
		if bytes.Contains(terminal, []byte(`"phase": "verified"`)) {
			if f.phase(t) != "verified" {
				t.Fatal("journal did not verify")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	logs, _ := os.ReadFile(filepath.Join(f.operation, "helper.log.jsonl"))
	helperError, _ := os.ReadFile(filepath.Join(f.dir, "stderr.log"))
	t.Fatalf("helper did not complete after Electron quit: %s %s %s", logs, helperError, stderr.String())
}

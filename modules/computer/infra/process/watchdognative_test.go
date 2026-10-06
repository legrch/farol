//go:build darwin && farol_native_process

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Lower-boundary interoperability ONLY: the exact existing Node resource,
// nativeWatchdogHost's retained helper/socket, and watchdogChild's real decoder.
// Synthetic commands are deliberately unconfined. No public constructor,
// Seatbelt, Qualification, product route, provider, shell or new helper engine.
// The failed hardlink confinement gate still refuses production qualification.
// The first native run at base 9209a96c FAILED in root-exit-0; command closure
// remains unverified. This diagnostic preparation does not qualify or rerun it.
// Run ONLY after a fresh Lead native-lane grant, with the exact test selector.
func TestNativeWatchdogTransport(t *testing.T) {
	selection := nativeWatchdogResource(t)
	for _, code := range []int{0, 7} {
		if !t.Run("root-exit-"+strconv.Itoa(code), func(t *testing.T) {
			f := nativeWatchdogStart(t, selection)
			// Cross the 48 KiB chunk boundary and preserve NUL/non-UTF-8 bytes.
			input := bytes.Repeat([]byte{0, 255, 'A', '\n'}, 16*1024+1)
			diagnostic := []byte{0, 255, 'E', 'R', 'R', '\n'}
			const command = `
const timer = setTimeout(() => process.exit(90), 1500);
// Darwin CoreFoundation may add its own per-UID text-encoding field after exec.
// It is not inherited command authority. Reject every other unexpected field;
// the selected environment remains exactly the two synthetic values below.
const encoding = process.env.__CF_USER_TEXT_ENCODING;
const encodingParts = typeof encoding === "string" &&
  /^(0x[0-9a-fA-F]+|[0-9]+):(0x[0-9a-fA-F]+|[0-9]+):(0x[0-9a-fA-F]+|[0-9]+)$/.exec(encoding);
const encodingValid = encoding === undefined ||
  (encodingParts && Number(encodingParts[1]) === process.getuid() &&
   encodingParts.slice(1).every((part) => Number(part) <= 0xffffffff));
// Distinct synthetic exit codes identify the failed guard without disclosing
// environment values. They do not change the command or transport's outcome.
if (process.cwd() !== process.env.SYNTHETIC_CWD) process.exit(91);
if (process.env.SYNTHETIC_VALUE !== "transport-only") process.exit(92);
if (!encodingValid) process.exit(93);
if (Object.keys(process.env).filter((name) => name !== "__CF_USER_TEXT_ENCODING").sort().join(",") !== "SYNTHETIC_CWD,SYNTHETIC_VALUE") process.exit(94);
if (process.argv[1] !== "opaque argument λ") process.exit(95);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(Buffer.concat(chunks), () => {
    process.stderr.write(Buffer.from([0, 255, 69, 82, 82, 10]), () => {
      clearTimeout(timer);
      process.exit(Number(process.argv[2]));
    });
  });
});`
			f.prepare(t, []string{"-e", command, "--", "opaque argument λ", strconv.Itoa(code)}, input,
				map[string]string{"SYNTHETIC_CWD": f.base, "SYNTHETIC_VALUE": "transport-only"})
			if err := f.child.send(f.ctx, watchdogControl{Type: "start", ID: f.child.id}); err != nil {
				f.fail(t, "single synthetic release", err)
			}
			if err := f.child.await(f.ctx, f.child.ready); err != nil {
				f.fail(t, "real ready frame", err)
			}
			f.settle(t)
			observation, err := f.observed.Read(context.Background(), processsvc.Window{})
			if err != nil || observation.Root != processsvc.RootExited || !observation.Waited ||
				observation.ExitCode == nil || *observation.ExitCode != code || observation.ExitSignal != 0 || !observation.OutputDrained {
				f.fail(t, "root exit/close facts unavailable", err)
			}
			// Read pages through the existing output owner, not test-invented IPC.
			var actual []byte
			for offset := uint64(0); offset < uint64(len(input)); {
				page, err := f.observed.Read(context.Background(), processsvc.Window{StdoutOffset: offset})
				if err != nil || page.StdoutNext <= offset {
					f.fail(t, "bounded output page unavailable", err)
				}
				actual = append(actual, page.Stdout...)
				offset = page.StdoutNext
			}
			if !bytes.Equal(actual, input) || !bytes.Equal(observation.Stderr, diagnostic) ||
				observation.StdoutBytes != uint64(len(input)) || observation.StderrBytes != uint64(len(diagnostic)) || observation.OutputLimitReached {
				t.Fatal("real binary stdout/stderr changed")
			}
			f.child.mutex.Lock()
			closed, uncertain, cohort := f.child.rootClosed, f.child.uncertain, f.child.root.cohort
			f.child.mutex.Unlock()
			if !closed || uncertain || cohort || observation.GroupCleanup != processsvc.CleanupUnverified ||
				observation.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("root close promoted to group/descendant qualification")
			}
			f.helperExit(t, true) // Helper self-SIGKILL is independent of root code.
			if _, err := f.child.Wait(); err == nil || f.witness.calls.Load() != 1 {
				t.Fatal("repeat decoder Wait reached the retained helper")
			}
		}) {
			return // A refused/unknown or failed case never launches another case.
		}
	}
	for _, stop := range []string{"stop-before-start", "disconnect-before-start"} {
		if !t.Run(stop, func(t *testing.T) {
			f := nativeWatchdogStart(t, selection)
			// A real marker would reveal unintended dispatch; this prepared command
			// must never start. No live-command cancellation/cohort claim is made.
			f.prepare(t, []string{"-e", `require("node:fs").writeFileSync("must-not-start", "SYNTHETIC"); process.exit(0);`}, nil, map[string]string{})
			if stop == "stop-before-start" {
				// EOF may fence between ACK delivery and await: either known intent
				// or classified unknown is valid, neither is root cleanup proof.
				if err := f.child.Kill(); err != nil {
					var failure *processsvc.NativeFailure
					if !errors.As(err, &failure) || !failure.Unknown {
						f.fail(t, "unclassified stop observation", err)
					}
				}
			} else {
				f.child.close() // Exact retained IPC EOF; no signal from Go.
			}
			f.settle(t)
			f.helperExit(t, false)
			f.child.mutex.Lock()
			started, ready, root, uncertain, ack := f.child.startSent, f.child.readySeen, f.child.rootExited, f.child.uncertain, f.child.stopSeen
			f.child.mutex.Unlock()
			observation, err := f.observed.Read(context.Background(), processsvc.Window{})
			if err != nil || started || ready || root || !uncertain || observation.Waited || observation.OutputDrained ||
				observation.ExitCode != nil || observation.ExitSignal != 0 || observation.StdoutBytes != 0 || observation.StderrBytes != 0 ||
				observation.GroupCleanup != processsvc.CleanupUnverified || observation.DescendantCleanup != processsvc.CleanupUnverified ||
				ack != (stop == "stop-before-start") {
				f.fail(t, "helper closure invented command facts", err)
			}
			if _, err := os.Lstat(filepath.Join(f.base, "must-not-start")); !errors.Is(err, os.ErrNotExist) {
				f.fail(t, "prepared command dispatched or marker outcome unknown", err)
			}
		}) {
			return
		}
	}
}

func nativeWatchdogResource(t *testing.T) WatchdogSelection {
	t.Helper()
	node, selected := os.LookupEnv("FAROL_TEST_WATCHDOG_NODE")
	if !selected || !filepath.IsAbs(node) || filepath.Clean(node) != node {
		t.Fatal("FAROL_TEST_WATCHDOG_NODE must select one explicit absolute Node v24.20.0 path; no discovery or fallback")
	}
	image, err := os.ReadFile(node)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(image)
	pin := ExecutablePin{Path: node, SHA256: hex.EncodeToString(digest[:])}
	measured, err := pinnedExecutable(pin)
	if err != nil {
		t.Fatal("selected exporter/helper image pin refused; no retry:", err)
	}
	defer measured.Close() // Retain the same image measurement through export.
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the exact source exporter")
	}
	exporter := filepath.Clean(filepath.Join(filepath.Dir(file), "../../../../tests/fixtures/watchdog-source.mjs"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// One bounded source export, with no watchdog execution or inherited env.
	// CommandContext may stop ONLY this exact exporter; never the helper/command.
	command := exec.CommandContext(ctx, pin.Path, exporter)
	command.Env = []string{}
	command.WaitDelay = time.Second
	raw, err := command.Output()
	if err != nil {
		t.Fatal("exact resource export refused/unknown; no alternate extractor:", err)
	}
	var resource struct {
		Source       string `json:"source"`
		SourceSHA256 string `json:"sourceSHA256"`
		NodeVersion  string `json:"nodeVersion"`
	}
	if json.Unmarshal(raw, &resource) != nil || resource.NodeVersion != "v24.20.0" || len(resource.Source) == 0 || len(resource.Source) > 64*1024 {
		t.Fatal("invalid exact watchdog resource export")
	}
	hash := sha256.Sum256([]byte(resource.Source))
	if resource.SourceSHA256 != hex.EncodeToString(hash[:]) {
		t.Fatal("exported watchdog source digest mismatch")
	}
	t.Logf("transport-only: Node %s at %s, image SHA256 %x, retained source SHA256 %s", resource.NodeVersion, pin.Path, digest, resource.SourceSHA256)
	return WatchdogSelection{Executable: pin,
		Source: []byte(resource.Source), SourceSHA256: resource.SourceSHA256}
}

type nativeWatchdogClock struct{}

func (nativeWatchdogClock) Now() time.Time { return time.Now() }

// Counting wrapper delegates to the SAME real owning Cmd.Wait. It fabricates no
// outcome, socket, event, clock or qualification evidence.
type nativeWatchdogWaitWitness struct {
	process watchdogProcess
	calls   atomic.Int32
	err     error // Read only after observed.done synchronizes Child.wait.
	done    chan struct{}
}

func (w *nativeWatchdogWaitWitness) Wait() error {
	w.calls.Add(1)
	w.err = w.process.Wait()
	close(w.done)
	return w.err
}

type nativeWatchdogFixture struct {
	selection WatchdogSelection
	base      string
	ctx       context.Context
	child     *watchdogChild
	observed  *Child
	native    *nativeWatchdogProcess
	witness   *nativeWatchdogWaitWitness
	retained  *os.Process
	channel   *watchdogDiagnosticChannel
	decoder   *watchdogDiagnosticWait
}

func nativeWatchdogStart(t *testing.T, selection WatchdogSelection) *nativeWatchdogFixture {
	t.Helper()
	base, err := os.MkdirTemp("/private/tmp", "farol-watchdog-transport-")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	f := &nativeWatchdogFixture{base: base, ctx: ctx, selection: selection}
	t.Cleanup(func() {
		defer cancel()
		if f.child != nil {
			f.logDiagnostics(t) // Also cover earlier prepare/start assertion failures.
			f.child.close()     // Sole cleanup control: close this retained IPC once.
			select {
			case <-f.observed.done:
				f.logDiagnostics(t)
			case <-time.After(2 * time.Second):
				f.logDiagnostics(t)
				t.Errorf("exact helper Wait/decoder closure unresolved; retain %s; no signal fallback/retry", base)
				return
			}
			f.child.mutex.Lock()
			commandUnresolved := f.child.startSent && !f.child.rootClosed
			f.child.mutex.Unlock()
			if f.witness.err != nil || f.native == nil || f.native.command.ProcessState == nil || commandUnresolved {
				t.Errorf("owned transport/command cleanup unknown; retain %s; production change requires escalation", base)
				return
			}
		}
		if err := os.RemoveAll(base); err != nil {
			t.Error("remove exact disposable tree:", err)
		}
	})
	checks := 0
	// Test-only dispatch adjacency check, NOT a permissive Qualification callback.
	process, channel, startErr := (nativeWatchdogHost{}).Start(ctx, selection, base, func() error { checks++; return ctx.Err() })
	if process == nil {
		if channel != nil {
			channel.Close()
		}
		t.Fatal("native helper preflight refused; no retry:", startErr)
	}
	f.native, _ = process.(*nativeWatchdogProcess)
	f.witness = &nativeWatchdogWaitWitness{process: process, done: make(chan struct{})}
	f.observed = &Child{handle: "synthetic-transport", root: processsvc.RootRunning,
		group: processsvc.CleanupPending, descendants: processsvc.CleanupPending, done: make(chan struct{})}
	deadline, _ := ctx.Deadline()
	var observedChannel watchdogChannel
	if channel != nil {
		f.channel = &watchdogDiagnosticChannel{watchdogChannel: channel}
		observedChannel = f.channel
	}
	f.child = newWatchdogChild(f.witness, observedChannel, deadline, nativeWatchdogClock{}, output{f.observed, false}, output{f.observed, true})
	correlation := sha256.Sum256([]byte(base))
	f.child.id = hex.EncodeToString(correlation[:]) // Synthetic correlation only.
	f.decoder = &watchdogDiagnosticWait{watchdogChild: f.child}
	f.observed.process = f.decoder
	if channel != nil {
		go f.child.receive()
	} else {
		f.child.fence()
		close(f.child.done)
	}
	go f.observed.wait()
	if startErr != nil || channel == nil || f.native == nil || f.native.command.Process == nil {
		f.fail(t, "possible helper start unknown; retained one Wait and IPC cleanup only", startErr)
	}
	f.retained = f.native.command.Process
	t.Logf("owned transport: tree=%s helper PID=%d correlation=%s", base, f.retained.Pid, f.child.id)
	command := f.native.command
	wantArgs := []string{selection.Executable.Path, "-e", string(selection.Source), "--", "--farol-go-prepared-v1"}
	wantEnv := []string{"ELECTRON_RUN_AS_NODE=1", "NODE_CHANNEL_FD=3", "NODE_CHANNEL_SERIALIZATION_MODE=json", "FAROL_SHELL_WATCHDOG_MODE=go-prepared-v1"}
	_, unixIPC := channel.(*net.UnixConn)
	if checks != 1 || command.Path != selection.Executable.Path || !reflect.DeepEqual(command.Args, wantArgs) ||
		!reflect.DeepEqual(command.Env, wantEnv) || command.Dir != base || len(command.ExtraFiles) != 1 || !unixIPC ||
		command.Cancel != nil || command.WaitDelay != time.Second || command.SysProcAttr == nil || !command.SysProcAttr.Setpgid ||
		f.channel.watchdogChannel != channel || f.child.channel != f.channel {
		f.fail(t, "retained native helper/image/source/IPC identity drift", nil)
	}
	return f
}

func (f *nativeWatchdogFixture) prepare(t *testing.T, args []string, input []byte, environment map[string]string) {
	t.Helper()
	deadline, _ := f.ctx.Deadline()
	message := watchdogPrepare{Type: "prepare", ID: f.child.id, Executable: f.selection.Executable.Path, Args: args,
		Cwd: f.base, Environment: environment, Stdin: base64.StdEncoding.EncodeToString(input), Deadline: deadline.UnixMilli()}
	if err := f.child.send(f.ctx, message); err != nil {
		f.fail(t, "one real prepare write", err)
	}
	if err := f.child.await(f.ctx, f.child.prepared); err != nil {
		f.fail(t, "real prepared frame", err)
	}
}

func (f *nativeWatchdogFixture) settle(t *testing.T) {
	t.Helper()
	select {
	case <-f.observed.done:
	case <-f.ctx.Done():
		f.fail(t, "bounded exact helper Wait/decoder closure unknown; cleanup retains unresolved evidence", f.ctx.Err())
	}
	f.logDiagnostics(t) // Unconditional, BEFORE helper or root fatal assertions.
	if f.witness.calls.Load() != 1 || f.witness.err != nil || f.native.command.Process != f.retained || f.native.command.ProcessState == nil {
		f.fail(t, "exact owning helper Wait facts unavailable", nil)
	}
}

func (f *nativeWatchdogFixture) helperExit(t *testing.T, killed bool) {
	t.Helper()
	f.logDiagnostics(t)
	status, ok := f.native.command.ProcessState.Sys().(syscall.WaitStatus)
	t.Logf("exact helper Wait: PID=%d status=%v calls=%d; group/descendants unverified", f.retained.Pid, status, f.witness.calls.Load())
	if !ok || killed && (!status.Signaled() || status.Signal() != syscall.SIGKILL) ||
		!killed && (!status.Exited() || status.ExitStatus() != 0) {
		t.Fatal("real helper exit differs from independent command-root facts")
	}
}

func (f *nativeWatchdogFixture) fail(t *testing.T, label string, err error) {
	t.Helper()
	f.logDiagnostics(t)
	t.Fatal(label, watchdogDiagnosticError(err))
}

func (f *nativeWatchdogFixture) logDiagnostics(t *testing.T) {
	t.Helper()
	if f.channel != nil {
		t.Logf("synthetic inbound IPC metadata: %+v", f.channel.snapshot())
	}
	if f.child != nil {
		f.child.mutex.Lock()
		t.Logf("decoder state: prepared=%t ready=%t startSent=%t uncertain=%t rootExited=%t rootClosed=%t bytes=%d; group/descendants unverified",
			f.child.preparedSeen, f.child.readySeen, f.child.startSent, f.child.uncertain, f.child.rootExited, f.child.rootClosed, f.child.bytes)
		f.child.mutex.Unlock()
	}
	if f.decoder != nil {
		f.decoder.mutex.Lock()
		t.Logf("decoder Wait: completed=%t error=%s rootWaited=%t drained=%t code=%s signal=%d cohort=%t",
			f.decoder.completed, f.decoder.failure, f.decoder.result.Waited, f.decoder.result.Drained,
			watchdogDiagnosticCode(f.decoder.result.Code), f.decoder.result.Signal, f.decoder.result.cohort)
		f.decoder.mutex.Unlock()
	}
	if f.witness == nil {
		return
	}
	select {
	case <-f.witness.done:
		if f.native == nil || f.native.command.ProcessState == nil {
			t.Logf("helper Wait: completed=true calls=%d error=%s ProcessState=unavailable", f.witness.calls.Load(), watchdogDiagnosticError(f.witness.err))
			return
		}
		state := f.native.command.ProcessState // Retained object only; no process query.
		status, ok := state.Sys().(syscall.WaitStatus)
		t.Logf("helper Wait: completed=true calls=%d error=%s retainedPID=%d ProcessState.exitCode=%d statusKnown=%t status=%v; not command cleanup",
			f.witness.calls.Load(), watchdogDiagnosticError(f.witness.err), state.Pid(), state.ExitCode(), ok, status)
	default:
		t.Logf("helper Wait: completed=false calls=%d ProcessState=unobserved", f.witness.calls.Load())
	}
}

// Delegate the one decoder Wait unchanged; retain its classified result even
// when Child.wait intentionally keeps only conservative public root facts.
type watchdogDiagnosticWait struct {
	*watchdogChild
	mutex     sync.Mutex
	completed bool
	failure   string
	result    exit
}

func (w *watchdogDiagnosticWait) Wait() (exit, error) {
	result, err := w.watchdogChild.Wait()
	w.mutex.Lock()
	w.completed, w.failure, w.result = true, watchdogDiagnosticError(err), result
	w.result.Code = copyCode(result.Code)
	w.mutex.Unlock()
	return result, err
}

func watchdogDiagnosticCode(code *int) string {
	if code == nil {
		return "unobserved"
	}
	return strconv.Itoa(*code)
}

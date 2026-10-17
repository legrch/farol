package helperchannels

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	nativeinput "github.com/legrch/farol/modules/release/infra/native/helperinput"
	nativeprotocol "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"golang.org/x/sys/unix"
)

// This is a DECLARED FIXTURE ABI, matching the launcher's role layout only:
// fd3=request, fd4=ACK, fd5=BORROWED lease, fd6=continuation. Nothing here
// authenticates a production launch or selects a Go helper. Stdin/stdout/stderr
// are separate test coordination/diagnostics, never protocol authority.
const processFixtureEnv = "FAROL_HELPERCHANNELS_PROCESS_FIXTURE"

// Snapshots query offset without moving it. Byte transport never receives fd5.
// F_GETFD is compared within each process: inheritance may change descriptor
// flags, while flags/offset/flock of the shared open description must survive.
type processBorrowed struct {
	Device, Inode  uint64
	Mode           uint32
	Size, Offset   int64
	Flags, FDFlags int
}

func processBorrowedSnapshot(t *testing.T, fd int) processBorrowed {
	t.Helper()
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		t.Fatal("borrowed lease no longer open:", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		t.Fatal("borrowed lease is not regular")
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		t.Fatal(err)
	}
	fdFlags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		t.Fatal(err)
	}
	offset, err := unix.Seek(fd, 0, io.SeekCurrent)
	if err != nil {
		t.Fatal(err)
	}
	return processBorrowed{uint64(st.Dev), uint64(st.Ino), uint32(st.Mode), st.Size, offset, flags, fdFlags}
}

func processJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func processRequest(t *testing.T, dir string, lease processBorrowed) map[string]any {
	t.Helper()
	return map[string]any{
		"schema": "farol.installed-update/1", "action": "apply", "home": dir,
		"operationId": strings.Repeat("1", 32),
		"source":      map[string]any{"digest": strings.Repeat("2", 64), "version": "fixture-source", "buildId": strings.Repeat("3", 64)},
		"target":      map[string]any{"digest": strings.Repeat("4", 64), "version": "fixture-target", "buildId": strings.Repeat("5", 64)},
		"drain":       map[string]any{"status": "reconciled", "acceptedSource": strings.Repeat("3", 64), "acceptedTarget": strings.Repeat("5", 64)},
		"pid":         os.Getpid(), "processStart": "synthetic fixture parent start", "waitSeconds": 30, "relaunch": true,
		"installLocation": "shared",
		"predecessor": map[string]any{
			"kind": "confirmed_closed", "startedAt": "2026-10-16T12:00:00Z", "lastQuitSha256": strings.Repeat("6", 64),
			"stateIdentity": map[string]any{"device": "11", "inode": "12"},
		},
		"leaseIdentity": map[string]any{"device": fmt.Sprint(lease.Device), "inode": fmt.Sprint(lease.Inode)},
	}
}

func processFrame(request map[string]any, schema string) map[string]any {
	frame := make(map[string]any)
	for _, key := range []string{"operationId", "action", "source", "target", "pid", "processStart", "predecessor", "leaseIdentity"} {
		frame[key] = request[key]
	}
	frame["schema"] = schema
	return frame
}

type processTerminal struct {
	Mode                  string
	PID                   int
	ContinuationValidated bool
	ContinuationOutcome   string
	Before, After         processBorrowed
}

// The fresh test executable returns through testing.Main, then the parent must
// observe that exact exec.Cmd's successful Wait. A terminal JSON line alone is
// only a pre-return receipt, never a product Quit or helper-exit classification.
func TestProcessCompositionChild(t *testing.T) {
	mode := os.Getenv(processFixtureEnv)
	if mode == "" {
		return
	}
	if mode != "sealed" && mode != "withheld-eof" {
		t.Fatal("unknown fixture mode")
	}
	before := processBorrowedSnapshot(t, 5)
	input := os.NewFile(3, "fixture-request")
	ack := os.NewFile(4, "fixture-ack")
	continuation := os.NewFile(6, "fixture-continuation")
	r, err := TakeRequest(input)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(); err != nil {
			t.Error(err)
		}
	})
	c, err := Take(ack, continuation)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := c.Close(); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	until := time.Now().Add(2 * time.Second)
	fmt.Println("fixture:ready")
	request, err := r.Read(ctx, until)
	if err != nil {
		t.Fatal(err)
	}
	s, err := protocolapp.Bind(ctx, request, inputapp.New(nativeinput.JSONDecoder{}), nativeprotocol.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := s.BuildHandoff(ctx, protocolapp.ClosedPredecessorReady, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Emit(ctx, until, frame); err != nil {
		t.Fatal(err)
	}
	wire, err := c.AwaitContinue(ctx, until)
	receipt := processTerminal{Mode: mode, PID: os.Getpid(), Before: before}
	if mode == "sealed" {
		if err != nil {
			t.Fatal(err)
		}
		if err := s.ValidateContinuation(ctx, wire); err != nil {
			t.Fatal(err)
		}
		receipt.ContinuationValidated = true
		receipt.ContinuationOutcome = "correlated"
	} else {
		outcome(t, err, "deadline", false)
		if wire != nil || time.Now().Before(until) {
			t.Fatal("unsealed continuation escaped its original deadline")
		}
		receipt.ContinuationOutcome = "helper_channels_deadline"
	}
	closed(t, input)
	closed(t, ack)
	closed(t, continuation)
	if after := processBorrowedSnapshot(t, 5); after != before {
		t.Fatalf("transport changed borrowed lease: before=%+v after=%+v", before, after)
	}
	fmt.Println("fixture:transport-returned")
	// Keep this exact child alive for the parent's live lock witness and late
	// write. Poll bounds test-only stdin without reconfiguring any role handle.
	processAwaitSignal(t)
	fresh := time.Now().Add(time.Second)
	wire, err = r.Read(ctx, fresh)
	outcome(t, err, "request_used", false)
	if wire != nil {
		t.Fatal("consumed request exposed bytes")
	}
	outcome(t, c.Emit(ctx, fresh, frame), "ack_used", true)
	wire, err = c.AwaitContinue(ctx, fresh)
	outcome(t, err, "continue_used", false)
	if wire != nil {
		t.Fatal("late continuation revived a consumed attempt")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	receipt.After = processBorrowedSnapshot(t, 5)
	if receipt.After != before {
		t.Fatalf("cleanup changed borrowed lease: before=%+v after=%+v", before, receipt.After)
	}
	fmt.Printf("fixture:terminal %s\n", processJSON(t, receipt))
}

func processAwaitSignal(t *testing.T) {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		poll := []unix.PollFd{{Fd: 0, Events: unix.POLLIN}}
		n, err := unix.Poll(poll, int(max(time.Until(until).Milliseconds(), 1)))
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || n != 1 || poll[0].Revents&unix.POLLIN == 0 {
			t.Fatalf("fixture signal unavailable: n=%d err=%v events=%x", n, err, poll[0].Revents)
		}
		var b [1]byte
		n, err = unix.Read(0, b[:])
		if err != nil || n != 1 || b[0] != 'x' {
			t.Fatalf("fixture signal invalid: n=%d err=%v", n, err)
		}
		return
	}
	t.Fatal("fixture signal deadline")
}

// Non-file writers make os/exec own stdout/stderr copying. Cmd.Wait joins both
// producers; events only coordinate the fixture and cannot authorize a handoff.
type processCapture struct {
	file    *os.File
	data    bytes.Buffer
	pending string
	events  chan string
}

func (w *processCapture) Write(p []byte) (int, error) {
	if w.data.Len()+len(p) > 64*1024 {
		return 0, errors.New("fixture diagnostic bound")
	}
	n, err := w.file.Write(p)
	w.data.Write(p[:n])
	w.pending += string(p[:n])
	for {
		line, rest, ok := strings.Cut(w.pending, "\n")
		if !ok {
			break
		}
		w.pending = rest
		if strings.HasPrefix(line, "fixture:") {
			select {
			case w.events <- line:
			default:
				return n, errors.New("fixture event bound")
			}
		}
	}
	return n, err
}

type processFixture struct {
	t      *testing.T
	dir    string
	files  []*os.File
	cmd    *exec.Cmd
	stdout *processCapture
	stderr *processCapture

	request      *os.File
	ack          *os.File
	continuation *os.File
	signal       *os.File
	lease        *os.File
	probe        *os.File

	done    chan struct{}
	waitErr error
	started time.Time
	killed  bool
}

func (f *processFixture) keep(file *os.File) *os.File {
	f.files = append(f.files, file)
	return file
}

func (f *processFixture) pipe() (*os.File, *os.File) {
	f.t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		f.t.Fatal(err)
	}
	return f.keep(r), f.keep(w)
}

func (f *processFixture) capture(name string) *processCapture {
	f.t.Helper()
	file, err := os.OpenFile(filepath.Join(f.dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		f.t.Fatal(err)
	}
	return &processCapture{file: f.keep(file), events: make(chan string, 8)}
}

func newProcessFixture(t *testing.T, mode string) *processFixture {
	t.Helper()
	// Deliberately not t.TempDir: failed, skipped or unknown state must survive.
	// Empty base preserves this host's physical macOS TMPDIR.
	dir, err := os.MkdirTemp("", "farol-helperchannels-process-")
	if err != nil {
		t.Fatal(err)
	}
	f := &processFixture{t: t, dir: dir}
	t.Log("retained process fixture:", dir)
	t.Cleanup(f.cleanup)
	f.lease, err = os.OpenFile(filepath.Join(dir, "borrowed-lease"), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	f.keep(f.lease)
	if _, err := f.lease.WriteString("borrowed fixture lease must survive"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lease.Seek(7, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if err := unix.Flock(int(f.lease.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.ENOTSUP) {
			t.Skip("fixture filesystem does not support flock; retained:", dir)
		}
		t.Fatal(err)
	}
	// Open again, never dup: this description must contend with the inherited
	// parent's description rather than merely aliasing its existing lock.
	f.probe, err = os.OpenFile(f.lease.Name(), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.keep(f.probe)
	f.contended()
	requestChild, requestParent := f.pipe()
	ackParent, ackChild := f.pipe()
	continuationChild, continuationParent := f.pipe()
	signalChild, signalParent := f.pipe()
	f.request, f.ack, f.continuation, f.signal = requestParent, ackParent, continuationParent, signalParent
	f.stdout, f.stderr = f.capture("stdout.log"), f.capture("stderr.log")
	f.cmd = exec.Command(os.Args[0], "-test.run=^TestProcessCompositionChild$", "-test.v", "-test.timeout=15s")
	f.cmd.Env = []string{processFixtureEnv + "=" + mode, "TMPDIR=" + os.TempDir()}
	f.cmd.Dir = dir
	f.cmd.Stdin, f.cmd.Stdout, f.cmd.Stderr = signalChild, f.stdout, f.stderr
	// Each owned role is a newly constructed pipe end. No dup/wrapper alias
	// is retained after Start; only fd5 intentionally shares a description.
	f.cmd.ExtraFiles = []*os.File{requestChild, ackChild, f.lease, continuationChild}
	f.cmd.WaitDelay = 2 * time.Second
	f.started = time.Now()
	if err := f.cmd.Start(); err != nil {
		t.Fatal("fixture start:", err)
	}
	f.done = make(chan struct{})
	go func() { f.waitErr = f.cmd.Wait(); close(f.done) }()
	for _, file := range []*os.File{requestChild, ackChild, continuationChild, signalChild} {
		if err := file.Close(); err != nil {
			t.Fatal("parent inherited-end close:", err)
		}
	}
	// Drop Go references as well as closing the parent's inherited pipe ends.
	f.cmd.ExtraFiles = nil
	return f
}

func (f *processFixture) contended() {
	f.t.Helper()
	err := unix.Flock(int(f.probe.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
		f.t.Fatalf("separate-description lease contention lost: %v", err)
	}
}

func (f *processFixture) event(want string) {
	f.t.Helper()
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	for {
		select {
		case line := <-f.stdout.events:
			if line == want {
				return
			}
		case <-f.done:
			// A fast exit may race delivery to this select; consume buffered
			// events before classifying it as an absent progress receipt.
			for len(f.stdout.events) > 0 {
				if <-f.stdout.events == want {
					return
				}
			}
			f.t.Fatalf("child exited before %s: %v; retained %s", want, f.waitErr, f.dir)
		case <-timer.C:
			f.t.Fatalf("child did not reach %s; retained %s", want, f.dir)
		}
	}
}

func processSend(t *testing.T, file *os.File, data []byte, seal bool) {
	t.Helper()
	if err := file.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if n, err := file.Write(data); err != nil || n != len(data) {
		t.Fatalf("fixture send n=%d want=%d err=%v", n, len(data), err)
	}
	if seal {
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *processFixture) await() {
	f.t.Helper()
	select {
	case <-f.done:
		if f.waitErr != nil || f.cmd.ProcessState == nil || !f.cmd.ProcessState.Success() {
			f.t.Fatalf("same-child Wait failed: %v; retained %s", f.waitErr, f.dir)
		}
		f.t.Logf("same-child pid=%d exit=%d stdout/stderr joined elapsed=%s", f.cmd.Process.Pid, f.cmd.ProcessState.ExitCode(), time.Since(f.started))
	case <-time.After(8 * time.Second):
		f.t.Fatal("same-child Wait deadline; cleanup will retain its abnormal receipt:", f.dir)
	}
}

func (f *processFixture) cleanup() {
	state := "not_started"
	if f.done != nil {
		select {
		case <-f.done:
		default:
			// Only the exact newly created fixture process through its retained
			// handle. A kill is explicit failure, never drained product Quit.
			f.killed = true
			err := f.cmd.Process.Kill()
			f.t.Errorf("abnormal fixture cleanup: Kill pid=%d err=%v; retained %s", f.cmd.Process.Pid, err, f.dir)
		}
		select {
		case <-f.done:
			exit := "unknown"
			if f.cmd.ProcessState != nil {
				exit = fmt.Sprint(f.cmd.ProcessState.ExitCode())
			} else {
				f.t.Error("fixture ProcessState unknown; retained:", f.dir)
			}
			joined := "unknown"
			if f.waitErr == nil {
				joined = "true"
			}
			state = fmt.Sprintf("wait_observed pid=%d exit=%s err=%v stdout_stderr_joined=%s killed=%t elapsed=%s", f.cmd.Process.Pid, exit, f.waitErr, joined, f.killed, time.Since(f.started))
		case <-time.After(5 * time.Second):
			state = "wait_unknown stdout_stderr_joined=unknown"
			f.t.Error("fixture terminal state unknown; retained:", f.dir)
		}
	}
	if !strings.HasPrefix(state, "wait_unknown") {
		for _, file := range f.files {
			if err := file.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
				f.t.Error("fixture close:", err)
			}
		}
	} // Unknown producers keep their diagnostic handles and retained state.
	receipt := fmt.Sprintf("%s\ntest_failed=%t test_skipped=%t\n", state, f.t.Failed(), f.t.Skipped())
	if err := os.WriteFile(filepath.Join(f.dir, "parent-terminal.txt"), []byte(receipt), 0600); err != nil {
		f.t.Error(err)
	}
	f.t.Log(strings.TrimSpace(receipt))
}

func TestProcessCompositionInheritedHandshake(t *testing.T) {
	for _, mode := range []string{"sealed", "withheld-eof"} {
		t.Run(mode, func(t *testing.T) {
			f := newProcessFixture(t, mode)
			before := processBorrowedSnapshot(t, int(f.lease.Fd()))
			request := processRequest(t, f.dir, before)
			f.event("fixture:ready")
			processSend(t, f.request, processJSON(t, request), true)
			if err := f.ack.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			ack, err := io.ReadAll(io.LimitReader(f.ack, maxFrame+1))
			if err != nil || len(ack) < 1 || len(ack) > maxFrame || ack[len(ack)-1] != '\n' {
				t.Fatalf("bounded ACK+EOF len=%d err=%v", len(ack), err)
			}
			var got, want map[string]any
			expected := processFrame(request, protocolapp.HandoffSchema)
			expected["phase"] = protocolapp.ClosedPredecessorReady
			if err := json.Unmarshal(ack, &got); err != nil {
				t.Fatal("not one ACK object:", err)
			}
			if err := json.Unmarshal(processJSON(t, expected), &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("ACK does not match the captured request")
			}
			continuation := processJSON(t, processFrame(request, protocolapp.ContinueSchema))
			processSend(t, f.continuation, continuation, mode == "sealed")
			f.event("fixture:transport-returned")
			if after := processBorrowedSnapshot(t, int(f.lease.Fd())); after != before {
				t.Fatalf("live child changed shared borrowed description: before=%+v after=%+v", before, after)
			}
			f.contended()
			if mode == "withheld-eof" {
				// The child has consumed and closed the original attempt. Its
				// valid bytes lacked EOF; late payload+EOF cannot grant admission.
				if err := f.continuation.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
					t.Fatal(err)
				}
				n, err := f.continuation.Write(continuation)
				if n != 0 || !errors.Is(err, unix.EPIPE) {
					t.Fatalf("late continuation write n=%d err=%v", n, err)
				}
				if err := f.continuation.Close(); err != nil {
					t.Fatal(err)
				}
			}
			processSend(t, f.signal, []byte("x"), true)
			f.await() // Wait also joins os/exec's stdout/stderr producers.
			if f.stderr.data.Len() != 0 {
				t.Fatalf("child stderr retained: %s", f.stderr.data.String())
			}
			var terminal processTerminal
			count := 0
			scanner := bufio.NewScanner(bytes.NewReader(f.stdout.data.Bytes()))
			for scanner.Scan() {
				if raw, ok := strings.CutPrefix(scanner.Text(), "fixture:terminal "); ok {
					count++
					if err := json.Unmarshal([]byte(raw), &terminal); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			wantOutcome := "correlated"
			if mode == "withheld-eof" {
				wantOutcome = "helper_channels_deadline"
			}
			if count != 1 || terminal.Mode != mode || terminal.PID != f.cmd.Process.Pid || terminal.ContinuationValidated != (mode == "sealed") || terminal.ContinuationOutcome != wantOutcome || terminal.Before != terminal.After {
				t.Fatalf("incomplete child receipt: count=%d %+v", count, terminal)
			}
			childLease := terminal.Before
			childLease.FDFlags = before.FDFlags // Descriptor flags are process-local.
			if childLease != before || processBorrowedSnapshot(t, int(f.lease.Fd())) != before {
				t.Fatal("borrowed lease flags/offset/identity changed across inheritance")
			}
			f.contended()
			content, err := os.ReadFile(f.lease.Name())
			if err != nil || string(content) != "borrowed fixture lease must survive" {
				t.Fatalf("borrowed lease contents changed: %v", err)
			}
			if err := f.lease.Close(); err != nil {
				t.Fatal(err)
			}
			// Calibrate the witness after the same child was reaped and the
			// parent's last alias closed: the independent description now wins.
			if err := unix.Flock(int(f.probe.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
				t.Fatal("lease did not release after actual terminal return:", err)
			}
		})
	}
}

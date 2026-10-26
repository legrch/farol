package process

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// These CPU tests start no OS child and perform no signal or PID lookup. Stream
// doubles exercise the actual witness; they do not qualify native EOF/no-fork.
func TestCommandOutputDrainedExitErrorWithoutEOF(t *testing.T) {
	cmd := &exec.Cmd{Stdout: io.Discard, Stderr: io.Discard}
	if commandOutputDrained(cmd, &exec.ExitError{}) {
		t.Fatal("ExitError hid missing independent stdout/stderr EOF evidence")
	}
}

func drainedCommand(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := &exec.Cmd{Stdout: &drainWitness{writer: io.Discard}, Stderr: &drainWitness{writer: io.Discard}}
	for _, writer := range []io.Writer{cmd.Stdout, cmd.Stderr} {
		if _, err := io.Copy(writer, struct{ io.Reader }{bytes.NewReader([]byte{0, 255, 'A'})}); err != nil {
			t.Fatal(err)
		}
	}
	return cmd
}

func TestCommandOutputDrainedRequiresBothIndependentCopies(t *testing.T) {
	for _, waitErr := range []error{nil, &exec.ExitError{}} {
		if !commandOutputDrained(drainedCommand(t), waitErr) {
			t.Fatal("independent EOF lost behind root exit", waitErr)
		}
	}
	cases := map[string]func(*exec.Cmd){
		"missing-stdout":      func(c *exec.Cmd) { c.Stdout = io.Discard },
		"missing-stderr":      func(c *exec.Cmd) { c.Stderr = io.Discard },
		"stdout-not-copied":   func(c *exec.Cmd) { c.Stdout = &drainWitness{writer: io.Discard} },
		"stderr-not-copied":   func(c *exec.Cmd) { c.Stderr = &drainWitness{writer: io.Discard} },
		"shared-pipe-witness": func(c *exec.Cmd) { c.Stderr = c.Stdout },
		"typed-nil":           func(c *exec.Cmd) { c.Stderr = (*drainWitness)(nil) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			cmd := drainedCommand(t)
			change(cmd)
			if commandOutputDrained(cmd, &exec.ExitError{}) {
				t.Fatal("missing independent copy became drained")
			}
		})
	}
	for _, err := range []error{exec.ErrWaitDelay, io.ErrClosedPipe, syscall.EPIPE, errors.New("unknown Wait")} {
		if commandOutputDrained(drainedCommand(t), err) {
			t.Fatal("unknown or bounded-drain failure became success", err)
		}
	}
	if commandOutputDrained(nil, nil) {
		t.Fatal("missing command became drained")
	}
}

type drainErrorReader struct{ err error }

func (r drainErrorReader) Read([]byte) (int, error) { return 0, r.err }

type drainErrorWriter struct{ err error }

func (w drainErrorWriter) Write([]byte) (int, error) { return 0, w.err }

type drainShortWriter struct{}

func (drainShortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

type drainFinalReader struct{}

func (drainFinalReader) Read(p []byte) (int, error) { return copy(p, []byte{0, 255, 'E'}), io.EOF }

func TestDrainWitnessEOFRequiresSuccessfulRetainedCopy(t *testing.T) {
	var retained bytes.Buffer
	w := &drainWitness{writer: &retained}
	if n, err := io.Copy(w, drainFinalReader{}); n != 3 || err != nil || !w.drained() || !bytes.Equal(retained.Bytes(), []byte{0, 255, 'E'}) {
		t.Fatal("last bytes with EOF were not retained", n, err)
	}
	for name, fixture := range map[string]struct {
		reader io.Reader
		writer io.Writer
	}{
		"read-failure":      {drainErrorReader{io.ErrUnexpectedEOF}, io.Discard},
		"forced-pipe-close": {drainErrorReader{os.ErrClosed}, io.Discard},
		"collector-failure": {drainFinalReader{}, drainErrorWriter{io.ErrClosedPipe}},
		"short-write":       {drainFinalReader{}, drainShortWriter{}},
		"nil-collector":     {drainFinalReader{}, nil},
	} {
		t.Run(name, func(t *testing.T) {
			w := &drainWitness{writer: fixture.writer}
			if _, err := io.Copy(w, fixture.reader); err == nil || w.drained() {
				t.Fatal("read/retention error counted as drain", err)
			}
		})
	}
	// WriterTo bypasses ReaderFrom: output bytes alone still grant no EOF.
	bypassed := &drainWitness{writer: io.Discard}
	if _, err := io.Copy(bypassed, bytes.NewReader([]byte("output"))); err != nil || bypassed.drained() {
		t.Fatal("optimized WriteTo invented EOF", err)
	}
	unobserved := &drainWitness{writer: io.Discard}
	if _, err := unobserved.Write([]byte("output")); err != nil || unobserved.drained() {
		t.Fatal("Write alone invented EOF", err)
	}
	if _, err := w.ReadFrom(bytes.NewReader(nil)); err == nil || w.drained() {
		t.Fatal("second copier reused a completed witness", err)
	}
}

func TestDirectLeafDrainDoesNotConfirmDescendants(t *testing.T) {
	for _, signal := range []bool{false, true} {
		cmd := drainedCommand(t)
		code := 7
		result := exit{Code: &code, Waited: true, Drained: commandOutputDrained(cmd, &exec.ExitError{})}
		if signal {
			result.Code, result.Signal = nil, 9
		}
		root := &ownedDouble{result: make(chan waited, 1)}
		root.result <- waited{result: result}
		child := &Child{handle: "synthetic-leaf", process: root, done: make(chan struct{})}
		child.wait()
		observed, err := child.Read(context.Background(), processsvc.Window{})
		if err != nil || !observed.Waited || !observed.OutputDrained || observed.GroupCleanup != processsvc.CleanupUnverified || observed.DescendantCleanup != processsvc.CleanupUnverified {
			t.Fatal("direct leaf drain promoted cohort cleanup", observed, err)
		}
		if receipt, err := child.Cancel(context.Background()); err != nil || receipt.Status != processsvc.AlreadyTerminal || root.killCount() != 0 {
			t.Fatal("post-wait cancellation signalled a replacement identity", receipt, err)
		}
	}
}

func TestAnchorDoubleNonzeroAndSignalKeepExistingNoForkRequirements(t *testing.T) {
	for _, signal := range []bool{false, true} {
		f := anchorFixture(t)
		code := 7
		f.guest.report.ExitCode = &code
		if signal {
			f.guest.report.ExitCode, f.guest.report.ExitSignal = nil, 9
		}
		report, err := f.run(context.Background())
		if err != nil || report == nil || !report.GuestCohortClosed {
			t.Fatal(report, err)
		}
		f = anchorFixture(t)
		f.guest.report.ExitCode = &code
		if signal {
			f.guest.report.ExitCode, f.guest.report.ExitSignal = nil, 9
		}
		f.guest.report.ForkObserved = true
		report, err = f.run(context.Background())
		f.requireUnknown(t, report, err)
	}
}

func TestAnchorDoublePassesIndependentWitnessesThroughExistingWriters(t *testing.T) {
	f := anchorFixture(t)
	if report, err := f.run(context.Background()); err != nil || report == nil {
		t.Fatal(report, err)
	}
	cmd := &exec.Cmd{Stdout: f.bootstrap.stdout, Stderr: f.bootstrap.stderr}
	if commandOutputDrained(cmd, nil) {
		t.Fatal("bootstrap alone invented EOF")
	}
	for _, writer := range []io.Writer{cmd.Stdout, cmd.Stderr} {
		if _, ok := writer.(*drainWitness); !ok {
			t.Fatal("bootstrap lost independent witness")
		}
		if _, err := io.Copy(writer, drainFinalReader{}); err != nil {
			t.Fatal(err)
		}
	}
	if !commandOutputDrained(cmd, &exec.ExitError{}) {
		t.Fatal("retained bootstrap writers lost independent EOF")
	}
}

func TestDrainWitnessIncompleteMemoryPipeStaysUnverified(t *testing.T) {
	reader, writer := io.Pipe() // Memory pipe only, no OS descriptor or process.
	defer reader.Close()
	defer writer.Close()
	w := &drainWitness{writer: io.Discard}
	done := make(chan error, 1)
	go func() { _, err := io.Copy(w, reader); done <- err }()
	if _, err := writer.Write([]byte{0, 255, 'P'}); err != nil {
		t.Fatal(err)
	}
	if w.drained() {
		t.Fatal("pending pipe EOF became drained")
	}
	if err := writer.CloseWithError(os.ErrClosed); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, os.ErrClosed) || w.drained() {
		t.Fatal("forced pipe closure became EOF", err)
	}
}

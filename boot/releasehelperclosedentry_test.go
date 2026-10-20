package boot

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	"golang.org/x/sys/unix"
)

// These witnesses use the same private symbolic seams as the closed helper unit
// tests. They never wrap descriptors 3-6 of the test process and never reach a
// native owner; the native lane exercises the real compiled entry.

const closedHelperEntryTestID = "11111111111111111111111111111111"

func closedHelperEntryRun(t *testing.T, f *closedHelperFixture) ([]byte, int) {
	t.Helper()
	return closedHelperEntry(context.Background(), closedHelperFiles{}, time.Now().Add(10*time.Second), f.deps())
}

func TestClosedHelperEntryRefusesExtraArguments(t *testing.T) {
	for _, args := range [][]string{{"x"}, {""}, {"--build-id", "x"}, {"closed"}} {
		var out, diag bytes.Buffer
		if code := runClosedReleaseHelper(args, &out, &diag); code != 2 || out.Len() != 0 || !strings.Contains(diag.String(), closedReleaseHelperCommand) {
			t.Fatal("extra argv was not refused before any descriptor or stdout use", args, code, out.String(), diag.String())
		}
		out.Reset()
		diag.Reset()
		if code := Run(append([]string{closedReleaseHelperCommand}, args...), nil, nopWriteCloser{&out}, &diag); code != 2 || out.Len() != 0 {
			t.Fatal("dispatcher accepted extra argv", args, code)
		}
	}
}

type nopWriteCloser struct{ *bytes.Buffer }

func (nopWriteCloser) Close() error { return nil }

func TestClosedHelperEntrySuccessWritesVerifiedLine(t *testing.T) {
	for _, action := range []string{"apply", "rollback"} {
		t.Run(action, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			phase := map[string]string{"apply": "verified", "rollback": "rolled_back"}[action]
			f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
				return &executionapp.Result{Phase: phase}, nil
			}
			line, exit := closedHelperEntryRun(t, f)
			want := `{"phase": "` + phase + `", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
			if exit != 0 || string(line) != want || f.execCalls != 1 || len(f.frames) != 1 {
				t.Fatalf("exit %d line %q exec %d frames %d", exit, line, f.execCalls, len(f.frames))
			}
			closedHelperClosedOnce(t, f)
		})
	}
}

func TestClosedHelperEntryCleanRefusalIsSeventy(t *testing.T) {
	f := newClosedHelperFixture(t)
	f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
		return nil, &executionapp.Failure{Phase: "prepared", Code: "staged_changed"}
	}
	line, exit := closedHelperEntryRun(t, f)
	want := `{"phase": "prepared", "error": "staged_changed", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
	if exit != 70 || string(line) != want || f.execCalls != 1 {
		t.Fatalf("exit %d line %q", exit, line)
	}
	closedHelperClosedOnce(t, f)
}

func TestClosedHelperEntryResultCodeIsRefusal(t *testing.T) {
	f := newClosedHelperFixture(t)
	f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
		return &executionapp.Result{Phase: "rolled_back", Code: "target_unverified"}, nil
	}
	line, exit := closedHelperEntryRun(t, f)
	want := `{"phase": "rolled_back", "error": "target_unverified", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
	if exit != 70 || string(line) != want {
		t.Fatalf("exit %d line %q", exit, line)
	}
}

func TestClosedHelperEntryUnknownFailuresAreSeventyNine(t *testing.T) {
	unknown := `{"phase": "unknown", "error": "internal", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
	for name, fn := range map[string]func(context.Context, closedHelperExecution) (*executionapp.Result, error){
		"uncertain": func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, &executionapp.Failure{Phase: "new_installed", Code: "x", Uncertain: true}
		},
		"internal": func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, &executionapp.Failure{Phase: "new_installed", Code: "x", Internal: true}
		},
		"foreign": func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, errors.New("foreign")
		},
		"wrapped": func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, errors.Join(&executionapp.Failure{Phase: "prepared", Code: "staged_changed"})
		},
		"panic": func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			panic("executor")
		},
		"nil-result": func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			f.execFn = fn
			line, exit := closedHelperEntryRun(t, f)
			if exit != 79 || string(line) != unknown || f.execCalls != 1 {
				t.Fatalf("exit %d line %q", exit, line)
			}
			closedHelperClosedOnce(t, f)
		})
	}
}

// A failed custody fence after Execute returned success must govern the result.
func TestClosedHelperEntryOuterErrorGovernsSuccess(t *testing.T) {
	probe := newClosedHelperFixture(t)
	if _, exit := closedHelperEntryRun(t, probe); exit != 0 {
		t.Fatal("control run failed")
	}
	f := newClosedHelperFixture(t)
	f.checkErr = errors.New("custody lost")
	f.failCheck = probe.checks // The final fence, after the callback returned.
	line, exit := closedHelperEntryRun(t, f)
	want := `{"phase": "unknown", "error": "internal", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
	if exit != 79 || string(line) != want || f.execCalls != 1 {
		t.Fatalf("exit %d line %q exec %d", exit, line, f.execCalls)
	}
}

// A clean pre-ACK refusal sends the one refused frame (as Python does) and never
// executes or takes the update lock; the full matrix is releasehelperrefusal_test.go.
func TestClosedHelperEntryPreACKRefusal(t *testing.T) {
	f := newClosedHelperFixture(t)
	f.readyErr = &executionapp.Failure{Phase: "prepared", Code: "staged_changed"}
	line, exit := closedHelperEntryRun(t, f)
	want := `{"phase": "prepared", "error": "staged_changed", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
	if exit != 70 || string(line) != want || len(f.frames) != 1 || f.execCalls != 0 || f.acquired != 0 {
		t.Fatalf("exit %d line %q frames %d exec %d", exit, line, len(f.frames), f.execCalls)
	}
}

// A refusal before the request is parsed has no usable operation ID.
func TestClosedHelperEntryRefusalBeforeRequestOmitsID(t *testing.T) {
	f := newClosedHelperFixture(t)
	f.input = []byte("{}")
	line, exit := closedHelperEntryRun(t, f)
	if exit != 79 || string(line) != "{\"phase\": \"unknown\", \"error\": \"internal\"}\n" || len(f.frames) != 0 || f.execCalls != 0 {
		t.Fatalf("exit %d line %q", exit, line)
	}
}

func TestClosedHelperEntryRelaunchIsRefusedBeforeACK(t *testing.T) {
	f := newClosedHelperFixture(t)
	f.input = bytes.Replace(f.input, []byte(`"relaunch":false`), []byte(`"relaunch":true`), 1)
	if !bytes.Contains(f.input, []byte(`"relaunch":true`)) {
		t.Fatal("fixture relaunch flag not replaced")
	}
	line, exit := closedHelperEntryRun(t, f)
	if exit != 79 || len(f.frames) != 0 || f.execCalls != 0 || f.readyCalls != 0 || closedHelperHas(f.events, "open") {
		t.Fatalf("relaunch reached IO: exit %d line %q events %v", exit, line, f.events)
	}
}

func TestClosedHelperEntryPanicIsSeventyNine(t *testing.T) {
	f := newClosedHelperFixture(t)
	deps := f.deps()
	deps.take = func(closedHelperFiles) (closedHelperInput, closedHelperChannels, error) { panic("take") }
	line, exit := closedHelperEntry(context.Background(), closedHelperFiles{}, time.Now().Add(time.Second), deps)
	if exit != 79 || string(line) != "{\"phase\": \"unknown\", \"error\": \"internal\"}\n" {
		t.Fatalf("exit %d line %q", exit, line)
	}
}

func TestClosedHelperEntryMissingReadyIsUnknown(t *testing.T) {
	f := newClosedHelperFixture(t)
	deps := f.deps()
	deps.ready = nil
	_, exit := closedHelperEntry(context.Background(), closedHelperFiles{}, time.Now().Add(time.Second), deps)
	if exit != 79 || len(f.frames) != 0 {
		t.Fatal("nil readiness seam reached the ACK", exit)
	}
}

func TestWriteClosedHelperTerminalIsOneNonBlockingWrite(t *testing.T) {
	var fds [2]int
	if err := unix.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	read, write := os.NewFile(uintptr(fds[0]), "r"), os.NewFile(uintptr(fds[1]), "w")
	defer read.Close()
	defer write.Close()
	line := []byte("{\"phase\": \"verified\"}\n")
	writeClosedHelperTerminal(write, line)
	got := make([]byte, 64)
	n, err := read.Read(got)
	if err != nil || !bytes.Equal(got[:n], line) {
		t.Fatal("line not delivered once", n, err)
	}
	flags, err := unix.FcntlInt(uintptr(fds[1]), unix.F_GETFL, 0)
	if err != nil || flags&unix.O_NONBLOCK == 0 {
		t.Fatal("terminal write did not use non-blocking semantics", flags, err)
	}
	// A full pipe must neither block nor retry: the line is dropped.
	filler := bytes.Repeat([]byte{'x'}, 4096)
	for {
		if _, err := unix.Write(fds[1], filler); err != nil {
			break
		}
	}
	done := make(chan struct{})
	go func() { writeClosedHelperTerminal(write, line); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal write blocked on a full pipe")
	}
}

func TestWriteClosedHelperTerminalIgnoresVanishedObserver(t *testing.T) {
	var fds [2]int
	if err := unix.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	if err := unix.Close(fds[0]); err != nil {
		t.Fatal(err)
	}
	write := os.NewFile(uintptr(fds[1]), "w")
	defer write.Close()
	writeClosedHelperTerminal(write, []byte("{}\n")) // EPIPE must neither panic nor kill the process.
}

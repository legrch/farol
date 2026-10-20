package boot

import (
	"context"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	"golang.org/x/sys/unix"
)

// closedReleaseHelperCommand is the executable entry of the closed release
// helper. It is flat, kebab-case and verb-first like its siblings
// (record-native-terminal, publish-installed-slot-binding) and keeps the
// composition's own name (closedReleaseHelper). The desktop selects it, with
// the promotion lease on fd5, for every closed apply and rollback; there is no
// interpreter alternative (installed-update-helper.ts).
const closedReleaseHelperCommand = "run-closed-release-helper"

// closedHelperEntryBudget is the original absolute bound of one helper process,
// shared by the closed and live entries. The request's waitSeconds (at most 120
// seconds, helperinput service) arrives inside the one-shot request and cannot
// be read before request work, so the entry fixes the bound at process start:
// it is captured before any request IO, never restarted, and no later phase or
// context can extend it. It is deliberately not tightened by waitSeconds.
//
// The desktop owns the waits that precede execution, all of them inside this one
// bound: readiness for the acknowledgement (at most 300 seconds, the launcher's
// readinessTimeoutMs ceiling), then the helper's own wait for the predecessor
// to exit or for the continuation frame (at most the 120 seconds waitSeconds
// admits). A bound of only 120 seconds from process start let a maximal
// desktop wait spend the entire budget before execution or relaunch began.
// 600 seconds is those two maxima plus 180 seconds for the staged copy,
// verification, promotion and relaunch, which is the same order as the 180
// second budget the desktop gives its own trusted measurements.
const closedHelperEntryBudget = 600 * time.Second

// closedHelperDescriptors are the fixed trusted-launch roles of the Python
// helper's channel layout (see installed-update-helper.ts): fd3 request, fd4
// ACK, fd5 borrowed promotion lease, fd6 continuation.
const (
	closedHelperRequestFD      = 3
	closedHelperACKFD          = 4
	closedHelperLeaseFD        = 5
	closedHelperContinuationFD = 6
)

// closedHelperEntryWriter receives the terminal line exactly once.
type closedHelperEntryWriter func(line []byte)

// closedHelperEntry is the testable logic of the entry: it never touches
// os.Exit, descriptors or the real stdout. It composes the closed custody
// protocol, runs the one Execute in its callback and maps the OUTER error plus
// the callback's captured outcome through closedHelperTerminal.
//
// Two refusals report 70. A clean post-continuation application refusal from
// execute is recorded and the callback returns nil, so the custody scope settles
// normally. A provably clean PRE-ACK refusal (see releasehelperrefusal.go) sends
// the one refused handoff frame inside the composition, as Python does, and
// comes back as *closedHelperRefused. Every other callback or composition failure
// becomes the outer error; any other non-nil outer error always governs and is
// classified as unknown (79). A panic anywhere in the entry yields exit 79.
func closedHelperEntry(ctx context.Context, files closedHelperFiles, until time.Time, deps closedHelperDependencies) (line []byte, exit int) {
	operationID := ""
	defer func() {
		if p := recover(); p != nil {
			line, exit = closedHelperTerminal(operationID, nil, closedHelperPanic(p))
		}
	}()
	// The operation ID is learned from the parsed, validated request as soon as
	// the pre-ACK readiness scope holds it, so a readiness refusal still names it.
	ready := deps.ready
	deps.ready = func(c context.Context, m *executionapp.Milestone, h closedReleaseHelper) (*executionapp.Readiness, error) {
		if h.state != nil {
			operationID = h.state.request.OperationID
		}
		if ready == nil {
			return nil, closedHelperFail(true)
		}
		return ready(c, m, h)
	}
	var result *executionapp.Result
	var executeErr error
	outer := withClosedReleaseHelperDependencies(ctx, files, until, func(scope closedReleaseHelper) error {
		if scope.state != nil {
			operationID = scope.state.request.OperationID
		}
		result, executeErr = scope.execute(ctx)
		if closedHelperCleanRefusal(executeErr) {
			return nil
		}
		return executeErr
	}, deps)
	if outer != nil {
		return closedHelperTerminal(operationID, nil, outer)
	}
	return closedHelperTerminal(operationID, result, executeErr)
}

// writeClosedHelperTerminal performs the single terminal write on fd1 with
// Python's emit_terminal semantics: non-blocking, SIGPIPE ignored, one attempt,
// any error or short write ignored and never retried. The line is far below
// PIPE_BUF, so a short write only happens when the observer is gone.
func writeClosedHelperTerminal(out io.Writer, line []byte) {
	file, ok := out.(*os.File)
	if !ok {
		_, _ = out.Write(line)
		return
	}
	raw, err := file.SyscallConn()
	if err != nil {
		return
	}
	// A vanished observer must surface as EPIPE, not as a fatal signal.
	signal.Ignore(syscall.SIGPIPE)
	_ = raw.Control(func(fd uintptr) {
		_ = unix.SetNonblock(int(fd), true)
		_, _ = unix.Write(int(fd), line)
	})
}

// runClosedReleaseHelper is the thin entry. Descriptors are wrapped here and
// nowhere else; the bound is captured first. It refuses any extra argument
// before touching a descriptor or writing stdout. The mapped exit code is
// returned to the existing os.Exit in cmd/farol.
func runClosedReleaseHelper(args []string, out io.Writer, diagnostics io.Writer) (exit int) {
	until := time.Now().Add(closedHelperEntryBudget)
	if len(args) != 0 {
		_, _ = io.WriteString(diagnostics, "usage: farol "+closedReleaseHelperCommand+"\n")
		return 2
	}
	defer func() {
		if p := recover(); p != nil {
			line, code := closedHelperTerminal("", nil, closedHelperPanic(p))
			writeClosedHelperTerminal(out, line)
			exit = code
		}
	}()
	files := closedHelperFiles{
		Request:      os.NewFile(closedHelperRequestFD, "farol-closed-helper-request"),
		ACK:          os.NewFile(closedHelperACKFD, "farol-closed-helper-ack"),
		Lease:        os.NewFile(closedHelperLeaseFD, "farol-closed-helper-lease"),
		Continuation: os.NewFile(closedHelperContinuationFD, "farol-closed-helper-continuation"),
	}
	line, code := closedHelperEntry(context.Background(), files, until, closedHelperProductionDependencies())
	writeClosedHelperTerminal(out, line)
	return code
}

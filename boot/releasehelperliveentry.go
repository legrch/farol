package boot

import (
	"context"
	"io"
	"os"
	"time"

	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
)

// liveReleaseHelperCommand is the executable entry of the live release helper
// (apply and rollback, relaunch false). Like its closed sibling it is flat,
// kebab-case and verb-first, and UNSELECTED: the desktop still spawns
// resources/native/update_helper.py and no launcher, resource, manifest or
// package step names this mode.
const liveReleaseHelperCommand = "run-live-release-helper"

// liveHelperEntry is the testable logic of the entry. It mirrors closedHelperEntry
// exactly: the same Execute callback, the same clean-refusal rule and the same
// terminal classification. A non-nil outer error always governs (79); a panic
// anywhere yields exit 79.
func liveHelperEntry(ctx context.Context, files liveHelperFiles, until time.Time, deps liveHelperDependencies) (line []byte, exit int) {
	operationID := ""
	defer func() {
		if p := recover(); p != nil {
			line, exit = closedHelperTerminal(operationID, nil, closedHelperPanic(p))
		}
	}()
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
	outer := withLiveReleaseHelperDependencies(ctx, files, until, func(scope closedReleaseHelper) error {
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

// runLiveReleaseHelper is the thin entry: it refuses any extra argument before
// touching a descriptor or stdout, captures the original bound first, wraps fd3
// and fd4 here and nowhere else, and returns the mapped exit code.
func runLiveReleaseHelper(args []string, out io.Writer, diagnostics io.Writer) (exit int) {
	until := time.Now().Add(closedHelperEntryBudget)
	if len(args) != 0 {
		_, _ = io.WriteString(diagnostics, "usage: farol "+liveReleaseHelperCommand+"\n")
		return 2
	}
	defer func() {
		if p := recover(); p != nil {
			line, code := closedHelperTerminal("", nil, closedHelperPanic(p))
			writeClosedHelperTerminal(out, line)
			exit = code
		}
	}()
	files := liveHelperFiles{
		Request: os.NewFile(liveHelperRequestFD, "farol-live-helper-request"),
		ACK:     os.NewFile(liveHelperACKFD, "farol-live-helper-ack"),
	}
	line, code := liveHelperEntry(context.Background(), files, until, liveHelperProductionDependencies())
	writeClosedHelperTerminal(out, line)
	return code
}

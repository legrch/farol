package boot

import (
	"context"
	"encoding/base64"
	"time"

	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// shellCheckResult reports only bounded facts; it does not retain raw output or
// create an execution authority. A timeout after Start is always unknown.
type shellCheckResult struct {
	Status, Code, Operation, Handle, CancelOperation string
	Supervisor                                       processct.SupervisorState
	GroupCleanup, DescendantCleanup                  processct.Cleanup
	RootWaited, OutputDrained                        bool
}

// checkShellForRun reserves a single check inside the original whole-run
// fence. A returned process result is not proof that its journal collector or
// descendants have settled; cleanup independently checks those owners.
func (r *selfTestRunLease) checkShellForRun(ctx context.Context, check *selfTestShell) shellCheckResult {
	refused := shellCheckResult{Status: "fail", Code: "PROCESS_UNAVAILABLE"}
	if r == nil || r.ledger == nil || ctx == nil || ctx.Err() != nil || check == nil || check.owner == nil || check.owner.mutations != r.ledger || check.workspace != r.workspace || check.operation == r.operation {
		return refused
	}
	s := r.ledger
	s.mu.Lock()
	record := s.operations[r.operation]
	if s.selfTestRun != r || r.active || r.cleanupStarted || r.ctx.Err() != nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil || record == nil || !record.stageScratch || !record.scratchCreated || record.selfTestRun != r || record.pending || !record.settled || record.scratch == nil || record.path != mutation.ScratchPath(r.operation) {
		s.mu.Unlock()
		return refused
	}
	check.mu.Lock()
	if check.attempted || check.run != nil {
		check.mu.Unlock()
		s.mu.Unlock()
		return refused
	}
	check.run = r
	check.mu.Unlock()
	r.active = true
	r.callDone = make(chan struct{})
	done := r.callDone
	s.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.ctx, cancel)
	defer func() {
		stop()
		cancel()
		s.mu.Lock()
		r.active = false
		close(done)
		s.mu.Unlock()
	}()
	return check.check(bounded)
}

func (s *selfTestShell) check(ctx context.Context) shellCheckResult {
	result := shellCheckResult{Status: "unknown", Operation: s.operation}
	recordTerminal := func(out *processct.ReadResponse) {
		result.Supervisor = out.Supervisor
		result.RootWaited = out.RootWaited
		result.GroupCleanup = out.GroupCleanup
		result.DescendantCleanup = out.DescendantCleanup
		result.OutputDrained = out.OutputDrained
	}
	classify := func(err error) shellCheckResult {
		outcome, _ := connectorProcessOutcome(nil, err)
		if outcome != nil {
			result.Code = outcome.Code
			if outcome.Status == "refused" && result.Handle == "" {
				result.Status = "fail"
			}
		}
		return result
	}
	start, err := s.start(ctx)
	if err != nil {
		return classify(err)
	}
	result.Handle = start.Handle
	if s.kind == selfTestShellCancel {
		read, err := s.read(ctx, 0, 0)
		if err != nil {
			return classify(err)
		}
		if read == nil || read.Handle != start.Handle || read.State == processct.Unknown {
			result.Code = "PROCESS_OUTCOME_UNKNOWN"
			return result
		}
		if read.State != processct.Running {
			recordTerminal(read)
			if (read.State != processct.Terminal && read.State != processct.Exited) || read.RootState != processct.RootExited || read.Supervisor != processct.SupervisorExited || !read.RootWaited || read.GroupCleanup != processct.CleanupConfirmed {
				result.Code = "PROCESS_OUTCOME_UNKNOWN"
				return result
			}
			result.Status, result.Code = "fail", "SELF_TEST_PROCESS_NOT_RUNNING"
			return result
		}
		result.CancelOperation = s.cancelOperation
		ack, err := s.cancel(ctx)
		if err != nil {
			return classify(err)
		}
		if ack == nil || ack.Status != processct.CancelRequested {
			result.Code = "PROCESS_OUTCOME_UNKNOWN"
			return result
		}
	}
	for {
		out, err := s.read(ctx, 0, 0)
		if err != nil {
			return classify(err)
		}
		if out == nil || out.Handle != start.Handle || out.State == processct.Unknown {
			result.Code = "PROCESS_OUTCOME_UNKNOWN"
			return result
		}
		if out.State != processct.Running {
			recordTerminal(out)
			if (out.State != processct.Terminal && out.State != processct.Exited) || out.RootState != processct.RootExited || out.Supervisor != processct.SupervisorExited || !out.RootWaited || out.GroupCleanup != processct.CleanupConfirmed || !out.OutputDrained || out.OutputLimitReached || out.AuthorityLost || out.TimedOut {
				result.Code = "PROCESS_OUTCOME_UNKNOWN"
				return result
			}
			if s.kind == selfTestShellQuick {
				output, err := base64.StdEncoding.Strict().DecodeString(out.StdoutBase64)
				if err != nil || out.StdoutOffset != 0 || out.StdoutNext != uint64(len(output)) || out.StdoutBytes != out.StdoutNext || out.StderrOffset != 0 || out.StderrNext != 0 || out.StderrBytes != 0 || out.StderrBase64 != "" || out.ExitCode == nil || *out.ExitCode != 0 || string(output) != "farol self-test\n" {
					result.Status, result.Code = "fail", "SELF_TEST_OUTPUT_MISMATCH"
					return result
				}
			} else if !out.CancelRequested || out.ExitSignal == 0 {
				result.Status, result.Code = "fail", "SELF_TEST_CANCEL_NOT_CONFIRMED"
				return result
			}
			result.Status = "pass"
			return result
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			result.Code = "PROCESS_OUTCOME_UNKNOWN"
			return result
		case <-timer.C:
		}
	}
}

package process

import "github.com/legrch/farol/modules/computer/app/services/output"

// ProjectTerminalDetails accepts only the original validated terminal result.
// The caller must supply the command before it enters any audit queue or store.
// A missing filter is deliberately unavailable, never an unfiltered fallback.
func ProjectTerminalDetails(result TerminalResult, command string, filter output.ScalarFilter) (output.Details, bool) {
	if !ValidTerminalResult(result) {
		return output.Details{}, false
	}
	o := result.Observation
	return output.Project(output.Input{
		Command: command, Stdout: o.Stdout, Stderr: o.Stderr,
		OutputDrained: o.OutputDrained, OutputLimited: o.OutputLimitReached,
		StdoutOffset: o.StdoutOffset, StderrOffset: o.StderrOffset,
		StdoutNext: o.StdoutNext, StderrNext: o.StderrNext,
		StdoutBytes: o.StdoutBytes, StderrBytes: o.StderrBytes,
	}, filter), true
}

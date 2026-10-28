package process

import "github.com/legrch/farol/modules/computer/app/services/output"

// ProjectTerminalDetails accepts only the original validated terminal result.
// The caller supplies a command filtered before it entered any audit queue or store.
// A missing filter is deliberately unavailable, never an unfiltered fallback.
func ProjectTerminalDetails(result TerminalResult, command output.Command, filter output.ScalarFilter) (output.Details, bool) {
	if !ValidTerminalResult(result) {
		return output.Details{}, false
	}
	o := result.Observation
	return output.ProjectWithCommand(output.Input{
		Stdout: o.Stdout, Stderr: o.Stderr,
		OutputDrained: o.OutputDrained, OutputLimited: o.OutputLimitReached,
		StdoutOffset: o.StdoutOffset, StderrOffset: o.StderrOffset,
		StdoutNext: o.StdoutNext, StderrNext: o.StderrNext,
		StdoutBytes: o.StdoutBytes, StderrBytes: o.StderrBytes,
	}, command, filter), true
}

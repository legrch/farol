package process

// ProjectTerminalDetails accepts only the original validated terminal result.
// The caller supplies a command filtered before it entered any audit queue or store.
// A missing filter is deliberately unavailable, never an unfiltered fallback.
func ProjectTerminalDetails(result TerminalResult, command AuditCommand, filter AuditScalarFilter) (AuditDetails, bool) {
	if !ValidTerminalResult(result) {
		return AuditDetails{}, false
	}
	o := result.Observation
	return ProjectAuditWithCommand(AuditInput{
		Stdout: o.Stdout, Stderr: o.Stderr,
		OutputDrained: o.OutputDrained, OutputLimited: o.OutputLimitReached,
		StdoutOffset: o.StdoutOffset, StderrOffset: o.StderrOffset,
		StdoutNext: o.StdoutNext, StderrNext: o.StderrNext,
		StdoutBytes: o.StdoutBytes, StderrBytes: o.StderrBytes,
	}, command, filter), true
}

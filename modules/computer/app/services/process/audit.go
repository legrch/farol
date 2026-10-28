package process

// TerminalAudit is a bounded, output-free observation of the original process.
// It carries no admission, replay, or current-owner authority.
type TerminalAudit struct {
	OperationID, BuildID, RuntimeID string
	ExitCode                        *int
	ExitSignal                      int
	RootWaited, OutputDrained       bool
	GroupCleanup, DescendantCleanup Cleanup
	TimedOut, AuthorityLost         bool
}

// ProjectTerminalAudit uses only a validated original terminal result. It never
// includes the command, workspace path, stdin, stdout, stderr, or binding data.
// The caller remains responsible for transport ownership and durable recording.
func ProjectTerminalAudit(result TerminalResult) (TerminalAudit, bool) {
	if !ValidTerminalResult(result) {
		return TerminalAudit{}, false
	}
	o := result.Observation
	var code *int
	if o.ExitCode != nil {
		value := *o.ExitCode
		code = &value
	}
	return TerminalAudit{
		OperationID:       result.Intent.OperationID,
		BuildID:           result.Scope.Host.BuildID,
		RuntimeID:         result.Scope.Host.RuntimeID,
		ExitCode:          code,
		ExitSignal:        o.ExitSignal,
		RootWaited:        o.Waited,
		OutputDrained:     o.OutputDrained,
		GroupCleanup:      o.GroupCleanup,
		DescendantCleanup: o.DescendantCleanup,
		TimedOut:          o.TimedOut,
		AuthorityLost:     o.AuthorityLost,
	}, true
}

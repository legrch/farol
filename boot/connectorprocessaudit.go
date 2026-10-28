package boot

import processsvc "github.com/legrch/farol/modules/computer/app/services/process"

// processTerminalAudit reads only an original, acknowledged publication owned
// by this backend lifetime. It neither resumes work nor restores READ authority.
// Foreign or incomplete references do not disclose a result.
func (s *computerConnector) processTerminalAudit(operation, build, runtime string) (processsvc.TerminalAudit, bool) {
	if s == nil || s.mutations == nil || !validIngressID(operation) || !validIngressID(build) || !validIngressID(runtime) {
		return processsvc.TerminalAudit{}, false
	}
	s.mutations.mu.Lock()
	defer s.mutations.mu.Unlock()
	record := s.mutations.operations[operation]
	if record == nil || record.process == nil || record.process.publication == "" || record.process.result == nil {
		return processsvc.TerminalAudit{}, false
	}
	result := record.process.result
	if result.Scope != record.process.origin || result.Intent.OperationID != operation || result.Scope.Host.BuildID != build || result.Scope.Host.RuntimeID != runtime {
		return processsvc.TerminalAudit{}, false
	}
	return processsvc.ProjectTerminalAudit(*result)
}

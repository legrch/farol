package boot

import (
	"context"
	"encoding/json"

	wire "github.com/legrch/farol/gen/desktop/v1"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

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

// processAuditMethod is a read-only host-pipe method, not an MCP capability.
// A missing fact says only that this owner has not observed a publication.
func (s *computerConnector) processAuditMethod() desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		if ctx == nil || ctx.Err() != nil || s == nil || s.lifetime.Err() != nil || r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerProcessAuditRequest", r.Body) != nil {
			return invalidIngress()
		}
		var request wire.ComputerProcessAuditRequest
		if json.Unmarshal(r.Body, &request) != nil {
			return invalidIngress()
		}
		result := wire.ComputerProcessAuditResult{State: "not_observed"}
		if fact, ok := s.processTerminalAudit(request.OperationId, request.BuildId, request.RuntimeId); ok {
			value := &wire.ComputerProcessTerminalAudit{OperationId: fact.OperationID, BuildId: fact.BuildID, RuntimeId: fact.RuntimeID,
				ExitSignal: uint32(fact.ExitSignal), RootWaited: fact.RootWaited, OutputDrained: fact.OutputDrained,
				GroupCleanup: string(fact.GroupCleanup), DescendantCleanup: string(fact.DescendantCleanup), TimedOut: fact.TimedOut, AuthorityLost: fact.AuthorityLost}
			if fact.ExitCode != nil {
				code := uint32(*fact.ExitCode)
				value.ExitCode = &code
			}
			result.State, result.Fact = "observed", value
		}
		return ingressOutcome(result, nil)
	}}
}

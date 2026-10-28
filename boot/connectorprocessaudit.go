package boot

import (
	"context"
	"encoding/json"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/services/output"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Audit is best effort: a slow filter must not hold a process start or Quit.
// Worker capacity is shared with terminal projection and remains bounded even
// if a defective filter never returns.
func (s *computerConnector) auditCommandProjection(ctx context.Context, value string) output.Command {
	filter := s.auditFilter
	if filter == nil {
		return output.ProjectCommand(value, nil)
	}
	select {
	case s.auditSlots <- struct{}{}:
	default:
		return output.Command{}
	}
	done := make(chan output.Command, 1)
	go func() {
		defer func() { <-s.auditSlots }()
		done <- output.ProjectCommand(value, filter)
	}()
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case command := <-done:
		return command
	case <-ctx.Done():
		return output.Command{}
	case <-timer.C:
		return output.Command{}
	}
}

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

// Details are projected once from the immutable original retained result. The
// potentially expensive filter runs without an owner lock and is never an
// execution or publication prerequisite.
func (s *computerConnector) processTerminalAuditDetails(ctx context.Context, operation, build, runtime string) (output.Details, bool) {
	if s == nil || s.mutations == nil || ctx == nil || ctx.Err() != nil || !validIngressID(operation) || !validIngressID(build) || !validIngressID(runtime) {
		return output.Details{}, false
	}
	s.mutations.mu.Lock()
	record := s.mutations.operations[operation]
	if record == nil || record.process == nil || record.process.publication == "" || record.process.result == nil {
		s.mutations.mu.Unlock()
		return output.Details{}, false
	}
	p := record.process
	result := p.result
	if result.Scope != p.origin || result.Intent.OperationID != operation || result.Scope.Host.BuildID != build || result.Scope.Host.RuntimeID != runtime {
		s.mutations.mu.Unlock()
		return output.Details{}, false
	}
	s.mutations.mu.Unlock()
	p.auditOnce.Do(func() {
		p.auditDone = make(chan struct{})
		select {
		case s.auditSlots <- struct{}{}:
			filter := s.auditFilter
			go func() {
				defer func() { <-s.auditSlots; close(p.auditDone) }()
				details, available := processsvc.ProjectTerminalDetails(*result, p.auditCommand, filter)
				p.auditMu.Lock()
				if !p.auditFinal {
					p.auditDetails, p.auditAvailable, p.auditFinal = details, available, true
				}
				p.auditMu.Unlock()
			}()
		default:
			p.auditMu.Lock()
			p.auditFinal = true
			p.auditMu.Unlock()
			close(p.auditDone)
		}
	})
	p.auditMu.Lock()
	if p.auditFinal {
		details, available := p.auditDetails, p.auditAvailable
		p.auditMu.Unlock()
		return details, available
	}
	p.auditMu.Unlock()
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-p.auditDone:
		p.auditMu.Lock()
		details, available := p.auditDetails, p.auditAvailable
		p.auditMu.Unlock()
		return details, available
	case <-ctx.Done():
		p.auditMu.Lock()
		p.auditFinal = true
		p.auditMu.Unlock()
		return output.Details{}, false
	case <-timer.C:
		p.auditMu.Lock()
		if !p.auditFinal {
			p.auditFinal = true
		}
		details, available := p.auditDetails, p.auditAvailable
		p.auditMu.Unlock()
		return details, available
	}
}

func auditExcerptWire(value output.Excerpt) wire.ComputerProcessAuditExcerpt {
	result := wire.ComputerProcessAuditExcerpt{State: value.State}
	if value.Reason != "" {
		result.Reason = &value.Reason
	}
	if value.Text != "" {
		result.Text = &value.Text
	}
	return result
}

// processAuditMethod is a read-only host-pipe method, not an MCP capability.
// A missing fact says only that this owner has not observed a publication.
func (s *computerConnector) processAuditMethod() desktop.Method {
	return desktop.Method{Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
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
			if details, available := s.processTerminalAuditDetails(ctx, request.OperationId, request.BuildId, request.RuntimeId); available {
				value.AuditDetails = &wire.ComputerProcessAuditDetails{Command: auditExcerptWire(details.Command), Stdout: auditExcerptWire(details.Stdout), Stderr: auditExcerptWire(details.Stderr)}
			} else {
				unavailable := "filter_unavailable"
				excerpt := wire.ComputerProcessAuditExcerpt{State: "unavailable", Reason: &unavailable}
				value.AuditDetails = &wire.ComputerProcessAuditDetails{Command: excerpt, Stdout: excerpt, Stderr: excerpt}
			}
			result.State, result.Fact = "observed", value
		}
		return ingressOutcome(result, nil)
	}}
}

package process

import (
	"bytes"
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// RetainedObserver reads one immutable, complete bounded execution VALUE. It has
// no Service or Child and cannot probe an old process, execute, admit, renew,
// settle, publish, acknowledge, cancel or retry anything.
type RetainedObserver struct {
	result    TerminalResult
	current   observationGuard
	workspace ObservationWorkspace
}

// NewRetainedObserver clones a validated result without owner or physical IO.
// Trusted root MUST reject an original UNKNOWN outcome and select the exact
// retained value using existing repository/lifecycle provenance. Valid bytes or
// this constructor alone do not prove known publication, a known ACK, clean
// retirement or cold-start eligibility; this reader grants none of those facts.
// Original owner/profile/computer and workspace/root/physical identity/cwd stay
// fixed. Current session/task/epoch/participant/turn and host/build/generations
// may differ only under the existing current READ owner's coherent authority.
func NewRetainedObserver(result TerminalResult, current ConnectorObservationAuthority, workspace ObservationWorkspace, clock port.Clock) (*RetainedObserver, error) {
	if current == nil || workspace == nil || clock == nil || !ValidTerminalResult(result) {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	// Bound allocation before copying, then validate the independent value we
	// actually retain before consulting any selected authority value methods.
	result = result.Clone()
	if !ValidTerminalResult(result) {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	selected := current.ConnectorScope()
	if !validConnectorReadScope(selected) {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	binding, deadline := current.Binding(), current.Deadline()
	if selected.OwnerID != result.Scope.OwnerID || binding.OwnerID != result.Scope.OwnerID {
		return nil, authority.Fail("AUTHORITY_OWNER_MISMATCH", "task-grant")
	}
	if selected.Host.ProfileID != result.Scope.Host.ProfileID || selected.ComputerID != result.Scope.ComputerID {
		return nil, authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	if !identifier(binding.SessionID) || !identifier(binding.TaskID) || !identifier(binding.ParticipantID) || !identifier(binding.TurnID) || binding.TaskEpoch > 9007199254740991 {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	now := clock.Now()
	guard := observationGuard{current: current, binding: binding, deadline: deadline, connector: &selected, clock: clock}
	if deadline.UnixMilli() <= 0 || deadline.UnixMilli() > 9007199254740991 || deadline.After(now.Add(authority.OrdinaryExecutionLifetime)) {
		return nil, authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	if err := guard.selected(now); err != nil {
		return nil, err
	}
	return &RetainedObserver{result: result, current: guard, workspace: workspace}, nil
}

// Read returns only the existing bounded windows and completion metadata, after
// current READ preflight, fresh physical observation outside owner gates, and
// current-authority recheck before disclosure. It never consults native state.
func (o *RetainedObserver) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	if o == nil || o.current.current == nil || o.workspace == nil || ctx == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	observed := o.result.Observation
	if request.Handle == "" || request.Handle != observed.Handle {
		return nil, fail("PROCESS_HANDLE_MISMATCH", false)
	}
	if request.StdoutOffset > MaximumOutput || request.StderrOffset > MaximumOutput ||
		request.StdoutOffset > observed.StdoutBytes || request.StderrOffset > observed.StderrBytes {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	var response *ReadResponse
	err := withObservedWorkspace(ctx, o.workspace, o.result.Intent.Seal, o.withAuthority, func() error {
		window := func(data []byte, offset uint64) []byte {
			return bytes.Clone(data[offset:min(offset+WindowBytes, uint64(len(data)))])
		}
		out := observed
		out.Stdout, out.Stderr = window(observed.Stdout, request.StdoutOffset), window(observed.Stderr, request.StderrOffset)
		out.StdoutOffset, out.StderrOffset = request.StdoutOffset, request.StderrOffset
		out.StdoutNext, out.StderrNext = request.StdoutOffset+uint64(len(out.Stdout)), request.StderrOffset+uint64(len(out.Stderr))
		if observed.ExitCode != nil {
			code := *observed.ExitCode
			out.ExitCode = &code
		}
		response = &ReadResponse{State: ResultState(o.result), Observation: out}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func (o *RetainedObserver) withAuthority(ctx context.Context, disclose func() error) error {
	return o.current.withAuthority(ctx, o.result.Intent.Seal, nil, disclose)
}

package task

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

// ContinueExactRequest opts into dispatch-scoped completed-parent control.
// MutationRequest remains unchanged for existing positional and legacy callers.
type ContinueExactRequest struct {
	OperationID, TaskID, Message, ExpectedDispatchID string
}

// ContinueExact binds the requested parent dispatch to the same snapshot whose
// revision is admitted by the existing journal CAS. It never substitutes latest
// state after an independent parent read, and never selects a new admission epoch.
func (s *Service) ContinueExact(ctx context.Context, req ContinueExactRequest) (*MutationResponse, error) {
	if !task.ID(req.ExpectedDispatchID) {
		return nil, task.ErrInvalid
	}
	return s.control(ctx, MutationRequest{OperationID: req.OperationID, TaskID: req.TaskID, Message: req.Message, Action: task.Continue}, req.ExpectedDispatchID)
}

// ResumeExactRequest is independent of ContinueExactRequest and legacy callers.
// The trusted Root supplies the selected Claude invocation and admission route.
type ResumeExactRequest struct {
	OperationID, TaskID, Message, ExpectedDispatchID string
}

// ResumeExact guards the selected terminal dispatch in the existing snapshot
// and journal CAS. It resumes through task.Resume, never through ContinueExact.
func (s *Service) ResumeExact(ctx context.Context, req ResumeExactRequest) (*MutationResponse, error) {
	if !task.ID(req.ExpectedDispatchID) {
		return nil, task.ErrInvalid
	}
	return s.control(ctx, MutationRequest{OperationID: req.OperationID, TaskID: req.TaskID, Message: req.Message, Action: task.Resume}, req.ExpectedDispatchID)
}

// Control distinguishes active Message/Cancel from terminal Continue/Resume.
func (s *Service) Control(ctx context.Context, req MutationRequest) (*MutationResponse, error) {
	return s.control(ctx, req, "")
}
func (s *Service) control(ctx context.Context, req MutationRequest, expectedDispatchID string) (*MutationResponse, error) {
	if !validRequest(req) || (req.Action != task.Continue && req.Action != task.Resume && req.Action != task.Message && req.Action != task.Cancel) {
		return nil, task.ErrInvalid
	}
	if replay, found, err := s.replayWithDispatch(ctx, req, nil, nil, expectedDispatchID); found {
		return replay, err
	}
	before, err := s.journal.Read(ctx, req.TaskID)
	if err != nil {
		return nil, classifiedRead(err)
	}
	if before == nil {
		return nil, task.ErrNotFound
	}
	if expectedDispatchID != "" && before.Task.DispatchID != expectedDispatchID {
		return nil, task.ErrIdentity
	}
	if before.Pending != "" {
		return nil, task.ErrUnknown
	}
	if err := s.recheck(ctx, before.Task.Binding); err != nil {
		return nil, err
	}
	if err := s.recheckParent(ctx, before.Task.Parent); err != nil {
		return nil, err
	}
	provider := s.providers[before.Task.Binding.Provider]
	if provider == nil {
		return nil, task.ErrUnavailable
	}
	caps, err := provider.Supports(ctx, before.Task.Binding)
	if err != nil {
		return nil, err
	}
	if !caps.Supports(req.Action) {
		return nil, task.ErrUnsupported
	}
	if !before.Task.Allows(req.Action, caps) {
		return nil, task.ErrState
	}
	intent := task.Intent{OperationID: req.OperationID, TaskID: req.TaskID, Action: req.Action, Binding: before.Task.Binding, Parent: before.Task.Parent, Expected: before.Task.Reference}
	return s.executeWithDispatch(ctx, req, intent, *before, expectedDispatchID)
}

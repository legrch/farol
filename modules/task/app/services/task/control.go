package task

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

// Control distinguishes active Message/Cancel from terminal Continue/Resume.
func (s *Service) Control(ctx context.Context, req MutationRequest) (*MutationResponse, error) {
	if !validRequest(req) || (req.Action != task.Continue && req.Action != task.Resume && req.Action != task.Message && req.Action != task.Cancel) {
		return nil, task.ErrInvalid
	}
	if replay, found, err := s.replay(ctx, req, nil, nil); found {
		return replay, err
	}
	before, err := s.journal.Read(ctx, req.TaskID)
	if err != nil {
		return nil, classifiedRead(err)
	}
	if before == nil {
		return nil, task.ErrNotFound
	}
	if before.Pending != "" {
		return nil, task.ErrUnknown
	}
	if err := s.recheck(ctx, before.Task.Binding); err != nil {
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
	return s.execute(ctx, req, intent, *before)
}

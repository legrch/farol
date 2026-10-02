package task

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type CreateRequest struct {
	OperationID, TaskID, Message string
	Selection                    port.Selection
	Parent                       task.Parent
}
type CreateResponse struct {
	OperationID, TaskID string
	Receipt             task.Receipt
}

func (s *Service) Create(ctx context.Context, req CreateRequest) (*CreateResponse, error) {
	mutation := MutationRequest{req.OperationID, req.TaskID, req.Message, task.Create}
	if !validRequest(mutation) || !req.Parent.Valid() {
		return nil, task.ErrInvalid
	}
	if req.Parent.ThreadID != "" {
		if err := s.authority.RecheckParent(ctx, req.Parent); err != nil {
			return nil, err
		}
	}
	// Replay uses the retained selection, never newly interpreted settings.
	if op, err := s.journal.Lookup(ctx, req.OperationID); err != nil {
		return nil, task.ErrUnknown
	} else if op != nil {
		b := op.Intent.Binding
		if b.Provider != req.Selection.Provider || b.ProjectID != req.Selection.ProjectID || b.WorkspaceID != req.Selection.WorkspaceID || b.ModelAlias != req.Selection.ModelAlias || b.Effort != req.Selection.Effort {
			return nil, task.ErrConflict
		}
		replay, _, err := s.replay(ctx, mutation, nil, &req.Parent)
		if err != nil {
			return nil, err
		}
		return &CreateResponse{replay.OperationID, replay.TaskID, replay.Receipt}, nil
	}
	resolved, err := s.Resolve(ctx, ResolveRequest{req.Selection})
	if err != nil {
		return nil, err
	}
	if !resolved.Capabilities.Create {
		return nil, task.ErrUnsupported
	}
	before := port.Snapshot{Task: task.Task{ID: req.TaskID, Binding: resolved.Binding, Parent: req.Parent, Lifecycle: task.Unknown}}
	intent := task.Intent{OperationID: req.OperationID, TaskID: req.TaskID, Action: task.Create, Binding: resolved.Binding, Parent: req.Parent}
	result, err := s.execute(ctx, mutation, intent, before)
	if err != nil {
		return nil, err
	}
	return &CreateResponse{result.OperationID, result.TaskID, result.Receipt}, nil
}

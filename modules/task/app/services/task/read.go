package task

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

type StatusRequest struct{ TaskID string }
type StatusResponse struct {
	Task               task.Task
	PendingOperationID string
}
type ResultRequest struct{ TaskID string }
type ResultResponse struct {
	TaskID, DispatchID string
	Reference          task.Reference
	Lifecycle          task.Lifecycle
	Text               string
	Retained           bool
}

func (s *Service) Status(ctx context.Context, req StatusRequest) (*StatusResponse, error) {
	if !task.ID(req.TaskID) {
		return nil, task.ErrInvalid
	}
	snapshot, err := s.journal.Read(ctx, req.TaskID)
	if err != nil {
		return nil, classifiedRead(err)
	}
	if snapshot == nil {
		return nil, task.ErrNotFound
	}
	current := snapshot.Task
	if err := s.recheck(ctx, current.Binding); err != nil {
		return nil, err
	}
	if snapshot.Pending == "" && current.Lifecycle == task.Running {
		provider := s.providers[current.Binding.Provider]
		if provider == nil {
			return nil, task.ErrUnavailable
		}
		observation, err := provider.Observe(ctx, current.Binding, current.Reference)
		if err != nil {
			return nil, task.ErrUnknown
		}
		if observation.Reference != current.Reference || !observation.Lifecycle.Valid() || observation.Lifecycle == task.Unknown || observation.Lifecycle == task.Refused || !validResult(observation.Result) {
			return nil, task.ErrIdentity
		}
		current.Lifecycle, current.Result = observation.Lifecycle, observation.Result
		if s.journal.Observe(ctx, *snapshot, current) != nil {
			return nil, task.ErrUnknown
		}
	}
	if err := s.recheck(ctx, current.Binding); err != nil {
		return nil, err
	}
	return &StatusResponse{current, snapshot.Pending}, nil
}
func (s *Service) Result(ctx context.Context, req ResultRequest) (*ResultResponse, error) {
	status, err := s.Status(ctx, StatusRequest{req.TaskID})
	if err != nil {
		return nil, err
	}
	current := status.Task
	if status.PendingOperationID != "" {
		return nil, task.ErrUnknown
	}
	return &ResultResponse{current.ID, current.DispatchID, current.Reference, current.Lifecycle, current.Result, current.Lifecycle.Terminal()}, nil
}

type OperationRequest struct{ OperationID string }
type OperationResponse struct {
	OperationID, TaskID string
	Action              task.Action
	Receipt             task.Receipt
}

// Operation is a read-only reconnect query. It never replays a mutation or calls a provider.
func (s *Service) Operation(ctx context.Context, req OperationRequest) (*OperationResponse, error) {
	if !task.ID(req.OperationID) {
		return nil, task.ErrInvalid
	}
	op, err := s.journal.Lookup(ctx, req.OperationID)
	if err != nil {
		return nil, task.ErrUnknown
	}
	if op == nil {
		return nil, task.ErrNotFound
	}
	if err := s.recheck(ctx, op.Intent.Binding); err != nil {
		return nil, err
	}
	if op.Intent.Action == task.Deliver {
		if err := s.authority.RecheckParent(ctx, op.Intent.Parent); err != nil {
			return nil, err
		}
	}
	receipt := op.Receipt
	if !op.Settled {
		receipt = task.Receipt{State: task.Uncertain}
	}
	return &OperationResponse{op.Intent.OperationID, op.Intent.TaskID, op.Intent.Action, receipt}, nil
}

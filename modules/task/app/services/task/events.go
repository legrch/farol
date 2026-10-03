package task

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type ExecutionRequest struct {
	TaskID, DispatchID, DeliveryOperationID string
	Cursor                                  task.EventCursor
	Limit                                   int
	IncludeResult                           bool
}
type ExecutionResponse struct {
	TaskID, DispatchID               string
	Reference                        task.Reference
	Page                             task.EventPage
	SourceGap, Pending, Retained     bool
	Lifecycle                        task.Lifecycle
	Result, ResultEvidence, Delivery string
}

func (s *Service) retained(ctx context.Context, id string) (*port.Operation, error) {
	if reader, ok := s.journal.(port.RetainedLookup); ok {
		return reader.LookupRetained(ctx, id)
	}
	return s.journal.Lookup(ctx, id)
}

// RecordExecution is a trusted selected-provider sink, not a public caller tool.
// No event can settle a mutation or replace deterministic terminal evidence.
func (s *Service) RecordExecution(ctx context.Context, e task.ExecutionEvent) error {
	if !task.ID(e.RunID) || !task.ID(e.DispatchID) || s.owned != nil && e.RunID != s.selected.TaskID {
		return task.ErrInvalid
	}
	op, err := s.journal.Lookup(ctx, e.DispatchID)
	if err != nil {
		return task.ErrUnknown
	}
	if op == nil {
		return task.ErrNotFound
	}
	if op.Intent.TaskID != e.RunID || !e.Valid(op.Intent.Binding.Provider) || e.Sequence != 0 || op.Intent.Action != task.Create && op.Intent.Action != task.Continue && op.Intent.Action != task.Resume {
		return task.ErrIdentity
	}
	ref := op.Lineage
	if op.Settled && op.Receipt.State == task.Known {
		ref = op.Receipt.Reference
	}
	if ref != e.Reference {
		return task.ErrIdentity
	}
	if op.Settled && op.Receipt.State != task.Known {
		return task.ErrState
	}
	if err := s.recheck(ctx, op.Intent.Binding); err != nil {
		return err
	}
	if op.Settled && op.Receipt.Lifecycle.Terminal() {
		return nil // Ignore exact late metadata AFTER authority recheck.
	}
	journal, ok := s.journal.(port.EventJournal)
	if !ok {
		return task.ErrUnsupported
	}
	if err := journal.RecordEvent(ctx, e); err != nil {
		s.fence()
		return err
	}
	return s.recheck(ctx, op.Intent.Binding)
}

// Execution returns a bounded retained snapshot plus changes. It never polls a
// provider, waits on MCP, dispatches, resolves unknown effects or delivers a result.
func (s *Service) Execution(ctx context.Context, req ExecutionRequest) (*ExecutionResponse, error) {
	if !task.ID(req.TaskID) || !task.ID(req.DispatchID) || req.Limit < 1 || req.Limit > task.EventPageLimit || req.DeliveryOperationID != "" && !task.ID(req.DeliveryOperationID) || s.owned != nil && req.TaskID != s.selected.TaskID {
		return nil, task.ErrInvalid
	}
	current, err := s.journal.Read(ctx, req.TaskID)
	if err != nil {
		return nil, classifiedRead(err)
	}
	if current == nil {
		return nil, task.ErrNotFound
	}
	op, err := s.retained(ctx, req.DispatchID)
	if err != nil {
		return nil, classifiedRead(err)
	}
	if op == nil {
		return nil, task.ErrNotFound
	}
	if op.Intent.TaskID != req.TaskID || op.Intent.Binding != current.Task.Binding || op.Intent.Parent != current.Task.Parent || op.Intent.Action != task.Create && op.Intent.Action != task.Continue && op.Intent.Action != task.Resume {
		return nil, task.ErrIdentity
	}
	if err := s.recheck(ctx, op.Intent.Binding); err != nil {
		return nil, err
	}
	ref := op.Lineage
	if op.Settled && op.Receipt.State == task.Known {
		ref = op.Receipt.Reference
	}
	if !op.Events.Valid(req.TaskID, req.DispatchID, op.Intent.Binding.Provider, ref) {
		return nil, task.ErrUnknown
	}
	page, err := op.Events.Page(req.Cursor, req.Limit)
	if err != nil {
		return nil, err
	}
	out := &ExecutionResponse{TaskID: req.TaskID, DispatchID: req.DispatchID, Reference: ref, Page: page, SourceGap: op.Events.SourceGap, Pending: !op.Settled, Lifecycle: task.Unknown, Delivery: "not_observed"}
	if op.Settled {
		out.Lifecycle = op.Receipt.Lifecycle
		if op.Receipt.State == task.Rejected {
			out.Lifecycle = task.Refused
		}
	}
	if op.Settled && op.Receipt.State == task.Known && op.Receipt.Lifecycle.Terminal() {
		if !validResult(op.Receipt.Result) || len(op.Receipt.Result) > 65536 {
			return nil, task.ErrUnknown
		}
		out.Retained = true
		out.ResultEvidence = "task_journal"
		if req.IncludeResult {
			out.Result = op.Receipt.Result
		}
	}
	if req.DeliveryOperationID != "" {
		if err := s.authority.RecheckParent(ctx, op.Intent.Parent); err != nil {
			return nil, err
		}
		delivery, err := s.retained(ctx, req.DeliveryOperationID)
		if err != nil {
			return nil, classifiedRead(err)
		}
		if delivery == nil {
			return nil, task.ErrNotFound
		}
		if delivery.Intent.Action != task.Deliver || delivery.Intent.TaskID != req.TaskID || delivery.Intent.Binding != op.Intent.Binding || delivery.Intent.Parent != op.Intent.Parent || delivery.Intent.Expected != ref {
			return nil, task.ErrIdentity
		}
		out.Delivery = "unknown"
		if delivery.Settled {
			if delivery.Receipt.State == task.Known && delivery.Receipt.Reference == ref {
				out.Delivery = "acknowledged"
			} else if delivery.Receipt.State == task.Rejected {
				out.Delivery = "refused"
			}
		}
		if err := s.authority.RecheckParent(ctx, op.Intent.Parent); err != nil {
			return nil, err
		}
	}
	if err := s.recheck(ctx, op.Intent.Binding); err != nil {
		return nil, err
	}
	return out, nil
}

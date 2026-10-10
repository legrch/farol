package task

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

type DeliverRequest struct{ OperationID, TaskID string }
type DeliverResponse struct {
	OperationID, TaskID string
	Receipt             task.Receipt
}

func (s *Service) Deliver(ctx context.Context, req DeliverRequest) (*DeliverResponse, error) {
	if !task.ID(req.OperationID) || !task.ID(req.TaskID) {
		return nil, task.ErrInvalid
	}
	// Delivery's message fingerprint is derived only from the retained result.
	if op, err := s.journal.Lookup(ctx, req.OperationID); err != nil {
		return nil, task.ErrUnknown
	} else if op != nil {
		if op.Intent.Action != task.Deliver || op.Intent.TaskID != req.TaskID {
			return nil, task.ErrConflict
		}
		if err := s.recheck(ctx, op.Intent.Binding); err != nil {
			return nil, err
		}
		if err := s.authority.RecheckParent(ctx, op.Intent.Parent); err != nil {
			return nil, err
		}
		r := op.Receipt
		if !op.Settled {
			r = task.Receipt{State: task.Uncertain}
		}
		return &DeliverResponse{req.OperationID, req.TaskID, r}, nil
	}
	before, err := s.journal.Read(ctx, req.TaskID)
	if err != nil {
		return nil, classifiedRead(err)
	}
	if before == nil {
		return nil, task.ErrNotFound
	}
	current := before.Task
	if before.Pending != "" {
		return nil, task.ErrUnknown
	}
	if !current.Lifecycle.Terminal() || !current.Reference.Complete(current.Binding.Provider) || current.Parent.ThreadID == "" {
		return nil, task.ErrState
	}
	if err := s.authority.RecheckParent(ctx, current.Parent); err != nil {
		return nil, err
	}
	if current.DeliveryDispatchID == current.DispatchID {
		return nil, task.ErrState
	}
	if s.delivery == nil {
		return nil, task.ErrUnavailable
	}
	if err := s.recheck(ctx, current.Binding); err != nil {
		return nil, err
	}
	intent := task.Intent{OperationID: req.OperationID, TaskID: req.TaskID, Action: task.Deliver, Binding: current.Binding, Parent: current.Parent, Expected: current.Reference}
	current, err = s.prepareAdmission(current, &intent)
	if err != nil {
		return nil, err
	}
	intent.Digest = s.digest(intent, current.Result)
	admitted, err := s.journal.Admit(ctx, intent, before.Revision, current)
	if err != nil {
		return nil, task.ErrUnknown
	}
	unknown := &DeliverResponse{req.OperationID, req.TaskID, task.Receipt{State: task.Uncertain}}
	if !admitted.Claimed {
		if admitted.Operation.Intent != intent {
			return nil, task.ErrConflict
		}
		// A competing caller may finish the same operation while Admit waits.
		// Its retained receipt is evidence, not authority for this disclosure.
		if err := s.recheck(ctx, current.Binding); err != nil {
			return nil, err
		}
		if err := s.authority.RecheckParent(ctx, current.Parent); err != nil {
			return nil, err
		}
		if admitted.Operation.Settled {
			return &DeliverResponse{req.OperationID, req.TaskID, admitted.Operation.Receipt}, nil
		}
		return unknown, nil
	}
	if err := s.recheck(ctx, current.Binding); err != nil {
		return unknown, nil
	}
	if err := s.authority.RecheckParent(ctx, current.Parent); err != nil {
		return unknown, nil
	}
	receipt, err := s.delivery.Send(ctx, current.Parent, req.OperationID, current.Reference, current.Result)
	if err != nil || (receipt.State != task.Known && receipt.State != task.Rejected) {
		return unknown, nil
	}
	if receipt.State == task.Known && receipt.Reference != current.Reference {
		return unknown, nil
	}
	if receipt.State == task.Rejected && !task.ID(receipt.Code) {
		return unknown, nil
	}
	current.DeliveryDispatchID = current.DispatchID
	if s.journal.Finish(ctx, req.OperationID, receipt, current) != nil {
		return unknown, nil
	}
	if err := s.recheck(ctx, current.Binding); err != nil {
		return nil, err
	}
	if err := s.authority.RecheckParent(ctx, current.Parent); err != nil {
		return nil, err
	}
	return &DeliverResponse{req.OperationID, req.TaskID, receipt}, nil
}

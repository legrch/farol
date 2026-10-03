package task

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type Service struct {
	journal     port.Journal
	authority   port.Authority
	providers   map[task.Provider]port.Provider
	delivery    port.Delivery
	fingerprint port.Fingerprint
	progress    port.ProgressFactory
}

func New(j port.Journal, a port.Authority, providers map[task.Provider]port.Provider, d port.Delivery, fingerprint port.Fingerprint, progress port.ProgressFactory) (*Service, error) {
	if j == nil || a == nil || fingerprint == nil || progress == nil {
		return nil, task.ErrUnavailable
	}
	copy := make(map[task.Provider]port.Provider, len(providers))
	for k, v := range providers {
		copy[k] = v
	}
	return &Service{j, a, copy, d, fingerprint, progress}, nil
}

type ResolveRequest struct{ Selection port.Selection }
type ResolveResponse struct {
	Binding      task.Binding
	Capabilities task.Capabilities
}

func (s *Service) Resolve(ctx context.Context, req ResolveRequest) (*ResolveResponse, error) {
	binding, err := s.authority.Resolve(ctx, req.Selection)
	if err != nil {
		return nil, err
	}
	if !binding.Valid() || binding.Provider != req.Selection.Provider || binding.ProjectID != req.Selection.ProjectID || binding.WorkspaceID != req.Selection.WorkspaceID || binding.ModelAlias != req.Selection.ModelAlias || binding.Effort != req.Selection.Effort {
		return nil, task.ErrIdentity
	}
	provider := s.providers[binding.Provider]
	if provider == nil {
		return nil, task.ErrUnavailable
	}
	caps, err := provider.Supports(ctx, binding)
	if err != nil {
		return nil, err
	}
	if err := s.recheck(ctx, binding); err != nil {
		return nil, err
	}
	return &ResolveResponse{binding, caps}, nil
}

type MutationRequest struct {
	OperationID, TaskID, Message string
	Action                       task.Action
}
type MutationResponse struct {
	OperationID, TaskID string
	Receipt             task.Receipt
}

func response(op task.Intent, receipt task.Receipt) *MutationResponse {
	return &MutationResponse{op.OperationID, op.TaskID, receipt}
}
func (s *Service) digest(intent task.Intent, message string) string {
	// Fixed structs, no maps: deterministic and content-free persistent intention.
	bytes, _ := json.Marshal(struct {
		Intent  task.Intent
		Message string
	}{intent, message})
	return s.fingerprint(bytes)
}
func validRequest(req MutationRequest) bool {
	return task.ID(req.OperationID) && task.ID(req.TaskID) && ((req.Action == task.Cancel && req.Message == "") || (req.Action != task.Cancel && task.Text(req.Message, 32768)))
}
func (s *Service) replay(ctx context.Context, req MutationRequest, binding *task.Binding, parent *task.Parent) (*MutationResponse, bool, error) {
	op, err := s.journal.Lookup(ctx, req.OperationID)
	if err != nil {
		return nil, true, task.ErrUnknown
	}
	if op == nil {
		return nil, false, nil
	}
	intent := op.Intent
	original := intent.Digest
	intent.Digest = ""
	if intent.TaskID != req.TaskID || intent.Action != req.Action || s.digest(intent, req.Message) != original || (binding != nil && intent.Binding != *binding) || (parent != nil && intent.Parent != *parent) {
		return nil, true, task.ErrConflict
	}
	if err := s.recheck(ctx, op.Intent.Binding); err != nil {
		return nil, true, err
	}
	receipt := op.Receipt
	if !op.Settled {
		receipt = task.Receipt{State: task.Uncertain}
	}
	return response(op.Intent, receipt), true, nil
}
func (s *Service) execute(ctx context.Context, req MutationRequest, intent task.Intent, before port.Snapshot) (*MutationResponse, error) {
	if err := s.recheck(ctx, intent.Binding); err != nil {
		return nil, err
	}
	intent.Digest = s.digest(intent, req.Message)
	admitted, err := s.journal.Admit(ctx, intent, before.Revision, before.Task)
	if err != nil {
		return nil, task.ErrUnknown
	}
	if !admitted.Claimed { // Race with the same operation: compare the entire intent.
		if admitted.Operation.Intent != intent {
			return nil, task.ErrConflict
		}
		receipt := admitted.Operation.Receipt
		if !admitted.Operation.Settled {
			receipt = task.Receipt{State: task.Uncertain}
		}
		if err := s.recheck(ctx, intent.Binding); err != nil {
			return nil, err
		}
		return response(intent, receipt), nil
	}
	unknown := response(intent, task.Receipt{State: task.Uncertain})
	// Recheck after durable admission and directly before the one effect call.
	if err := s.recheck(ctx, intent.Binding); err != nil {
		receipt := task.Receipt{State: task.Rejected, Code: "TASK_AUTHORITY_REFUSED"}
		next := before.Task
		if req.Action == task.Create {
			next.Lifecycle = task.Refused
		}
		if s.journal.Finish(ctx, intent.OperationID, receipt, next) != nil {
			return unknown, nil
		}
		return response(intent, receipt), nil
	}
	provider := s.providers[intent.Binding.Provider]
	var lineage task.Reference
	progress := s.progress(func(ctx context.Context, ref task.Reference) error {
		if !lineage.Extend(ref, intent.Binding.Provider) ||
			(intent.Binding.Provider == task.Claude && (req.Action == task.Create || req.Action == task.Resume) && ref.InvocationID != "" && ref.InvocationID != intent.OperationID) ||
			(req.Action != task.Create && !intent.Expected.SameSession(ref, intent.Binding.Provider)) ||
			((req.Action == task.Message || req.Action == task.Cancel) && ref != intent.Expected) ||
			((req.Action == task.Continue || req.Action == task.Resume) && ref == intent.Expected) {
			return task.ErrIdentity
		}
		if err := s.journal.Progress(ctx, intent.OperationID, ref); err != nil {
			return err
		}
		lineage = ref
		return nil
	})
	if progress == nil {
		return unknown, nil
	}
	receipt, err := provider.Dispatch(ctx, port.Dispatch{Intent: intent, Message: req.Message}, func(ref task.Reference) error {
		return progress.Record(ctx, ref)
	})
	// Join in-flight callbacks and seal the operation before reading lineage.
	// A callback failure remains binding even if the provider ignores it.
	progressErr := progress.Close(func() error {
		if (receipt.State == task.Known && !lineage.Extend(receipt.Reference, intent.Binding.Provider)) ||
			(receipt.State == task.Rejected && lineage != (task.Reference{})) {
			return task.ErrIdentity
		}
		return nil
	})
	if err != nil || receipt.State == task.Uncertain || progressErr != nil {
		return unknown, nil
	}
	next, err := apply(before.Task, intent, receipt)
	if err != nil {
		return unknown, nil
	}
	if s.journal.Finish(ctx, intent.OperationID, receipt, next) != nil {
		return unknown, nil
	}
	if err := s.recheck(ctx, intent.Binding); err != nil {
		return nil, err
	}
	return response(intent, receipt), nil
}
func apply(before task.Task, intent task.Intent, r task.Receipt) (task.Task, error) {
	next := before
	if r.State == task.Rejected {
		if !task.ID(r.Code) {
			return before, task.ErrInvalid
		}
		if intent.Action == task.Create {
			next.Lifecycle = task.Refused
		}
		return next, nil
	}
	if r.State != task.Known || !r.Reference.Complete(intent.Binding.Provider) || (intent.Binding.Provider == task.Claude && (intent.Action == task.Create || intent.Action == task.Resume) && r.Reference.InvocationID != intent.OperationID) {
		return before, task.ErrIdentity
	}
	switch intent.Action {
	case task.Create, task.Continue, task.Resume:
		if !r.Lifecycle.Valid() || r.Lifecycle == task.Unknown || r.Lifecycle == task.Refused || len(r.Result) > 65536 || !validResult(r.Result) {
			return before, task.ErrInvalid
		}
		if intent.Action != task.Create && (!intent.Expected.SameSession(r.Reference, intent.Binding.Provider) || intent.Expected == r.Reference) {
			return before, task.ErrIdentity
		}
		next.Reference, next.Lifecycle, next.Result, next.DispatchID, next.CancelRequested = r.Reference, r.Lifecycle, r.Result, intent.OperationID, false
		next.DeliveryDispatchID = ""
	case task.Message:
		if r.Reference != intent.Expected || r.Lifecycle != task.Running || r.Result != "" || r.CancelRequested {
			return before, task.ErrIdentity
		}
	case task.Cancel:
		if r.Reference != intent.Expected || r.Lifecycle != task.Running || !r.CancelRequested || r.Result != "" {
			return before, task.ErrIdentity
		}
		// Cancellation acknowledgement is only requested, never terminal proof.
		next.CancelRequested = true
	default:
		return before, task.ErrInvalid
	}
	return next, nil
}
func validResult(text string) bool { return text == "" || task.Text(text, 65536) }
func classifiedRead(err error) error {
	if errors.Is(err, task.ErrNotFound) {
		return task.ErrNotFound
	}
	return task.ErrUnknown
}

func (s *Service) recheck(ctx context.Context, binding task.Binding) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.authority.Recheck(ctx, binding)
}

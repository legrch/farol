package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// SettingsDeliveryIngress owns transport correlation only. All public calls
// share gate; the application has its separate injected gate. Begin and Execute
// remain within one Apply invocation so the host never owns an execution Permit.
// This preparation is not registered by NativeRuntime until host cutover.
type SettingsDeliveryIngress struct {
	gate                     sync.Mutex
	mutations                *SettingsMutationIngress
	store                    delivery.Store
	service                  *delivery.Service
	initialAttempted, frozen bool
	initialErr               error
	publications             map[string]wire.ComputerAuthorityPublication
	receipts                 map[string]*delivery.Receipt
	receiptIDs               map[string]string
}

func NewSettingsDeliveryIngress(mutations *SettingsMutationIngress, store delivery.Store) (*SettingsDeliveryIngress, error) {
	if mutations == nil || mutations.computer == nil || store == nil {
		return nil, delivery.ErrInvalid
	}
	return &SettingsDeliveryIngress{mutations: mutations, store: store, publications: make(map[string]wire.ComputerAuthorityPublication), receipts: make(map[string]*delivery.Receipt), receiptIDs: make(map[string]string)}, nil
}

func (s *SettingsDeliveryIngress) initialize(ctx context.Context) error {
	if s.initialAttempted {
		return s.initialErr
	}
	s.initialAttempted = true
	s.initialErr = delivery.ErrFenced
	snapshot, err := s.store.Load(ctx)
	if err != nil {
		s.initialErr = err
		return err
	}
	computer := s.mutations.computer
	if snapshot.Current.ProfileID != computer.peer.ProfileId || snapshot.Current.OwnerID != computer.ownerID || snapshot.Current.ComputerID != computer.computerID {
		return s.initialErr
	}
	clock := computer.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	s.service, err = delivery.New(snapshot.Current, s.store, settingsDeliveryOutcomes{s}, clock, &sync.Mutex{})
	if err != nil {
		s.initialErr = err
		return err
	}
	// Reconcile retained pending before this new owner can prove retirement.
	// This is exact observation only; neither edits nor permits are reconstructed.
	if snapshot.Pending != nil {
		if _, err = s.service.Observe(ctx, *snapshot.Pending); err != nil {
			s.initialErr = err
			return err
		}
	}
	s.initialErr = nil
	return nil
}

func settingsDeliveryContext(ctx context.Context, deadline string) (context.Context, context.CancelFunc, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, nil, delivery.ErrInvalid
	}
	n, err := strconv.ParseUint(deadline, 10, 64)
	if err != nil || n > 9007199254740991 {
		return nil, nil, delivery.ErrInvalid
	}
	until := time.UnixMilli(int64(n))
	if remaining := time.Until(until); remaining <= 0 || remaining > 15*time.Second {
		return nil, nil, delivery.ErrInvalid
	}
	call, cancel := context.WithDeadline(ctx, until)
	return call, cancel, nil
}

func (s *SettingsDeliveryIngress) apply(ctx context.Context, operation string, input wire.SettingsDeliveryApply) (*wire.SettingsDeliveryResult, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.frozen {
		return nil, delivery.ErrEffectUnsettled
	}
	if _, exists := s.publications[operation]; exists || len(s.publications) >= delivery.MaxAttempts {
		return nil, delivery.ErrConsumed
	}
	if err := s.initialize(ctx); err != nil {
		return nil, err
	}
	request := input.Request
	generation, err := strconv.ParseUint(request.Publication.Generation, 10, 64)
	if err != nil {
		return nil, delivery.ErrInvalid
	}
	// Reserve before calling the application; a refused original Apply cannot
	// be silently repaired by another payload with the same operation identity.
	s.publications[operation] = request.Publication
	computer := s.mutations.computer
	selection := delivery.Selection{OperationID: operation, ProfileID: computer.peer.ProfileId, OwnerID: computer.ownerID, ComputerID: computer.computerID, ComputerGeneration: generation}
	edits := make([]delivery.TextEdit, len(request.Edits))
	for i, edit := range request.Edits {
		edits[i] = delivery.TextEdit{OldText: edit.OldText, NewText: edit.NewText}
	}
	permit, err := s.service.Begin(ctx, selection, delivery.EditRequest{WorkspaceID: request.WorkspaceId, Operation: delivery.Edit{RelativePath: request.RelativePath, ExpectedSHA256: request.ExpectedSHA256, Edits: edits}})
	if err != nil {
		return nil, err
	}
	if _, err = s.service.Execute(ctx, permit); err != nil {
		return nil, err
	}
	return s.offer(ctx, permit.Binding())
}

func (s *SettingsDeliveryIngress) observe(ctx context.Context, input wire.SettingsDeliveryObserve) (*wire.SettingsDeliveryResult, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.frozen {
		return nil, delivery.ErrEffectUnsettled
	}
	if err := s.initialize(ctx); err != nil {
		return nil, err
	}
	pending, err := settingsDeliveryPending(input.Pending)
	if err != nil {
		return nil, err
	}
	return s.offer(ctx, pending)
}

func (s *SettingsDeliveryIngress) offer(ctx context.Context, pending delivery.Pending) (*wire.SettingsDeliveryResult, error) {
	receipt, err := s.service.Offer(ctx, pending)
	if errors.Is(err, delivery.ErrNotReady) {
		return &wire.SettingsDeliveryResult{State: "pending", Pending: *settingsPendingToWire(&pending)}, nil
	}
	if err != nil {
		return nil, err
	}
	result, err := settingsDeliveryResult(receipt.Outcome(), pending)
	if err != nil {
		return nil, err
	}
	id := s.receiptIDs[pending.OperationID]
	if id == "" {
		if len(s.receipts) >= delivery.MaxAttempts {
			return nil, delivery.ErrCapacity
		}
		id, err = randomIngressID()
		if err != nil || s.receipts[id] != nil {
			return nil, delivery.ErrFenced
		}
		s.receipts[id], s.receiptIDs[pending.OperationID] = receipt, id
	} else if s.receipts[id] != receipt {
		return nil, delivery.ErrInvalid
	}
	retention := "memory_only"
	if receipt.Retention() == delivery.Durable {
		retention = "durable"
	}
	return &wire.SettingsDeliveryResult{State: "offered", Pending: *settingsPendingToWire(&pending), ReceiptId: &id, Result: result, Retention: &retention}, nil
}

func (s *SettingsDeliveryIngress) acknowledge(ctx context.Context, input wire.SettingsDeliveryACK) (*wire.SettingsDeliveryACKResult, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.frozen || s.service == nil {
		return nil, delivery.ErrInvalid
	}
	pending, err := settingsDeliveryPending(input.Pending)
	if err != nil {
		return nil, err
	}
	receipt := s.receipts[input.ReceiptId]
	if receipt == nil || receipt.Binding() != pending {
		return nil, delivery.ErrInvalid
	}
	if err := s.service.ACK(ctx, receipt); err != nil {
		return nil, err
	}
	return &wire.SettingsDeliveryACKResult{ReceiptId: input.ReceiptId, Pending: input.Pending, Acknowledged: true}, nil
}

func (s *SettingsDeliveryIngress) freezeForRetirement(ctx context.Context) error {
	if s == nil {
		return nil
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	s.frozen = true
	if err := s.initialize(ctx); err != nil {
		return err
	}
	return s.service.FreezeForRetirement()
}

func settingsDeliveryPending(p wire.SettingsStorePending) (delivery.Pending, error) {
	generation, err := strconv.ParseUint(p.ComputerGeneration, 10, 64)
	if err != nil {
		return delivery.Pending{}, delivery.ErrInvalid
	}
	return delivery.Pending{Backend: p.Backend, OperationID: p.OperationId, ProfileID: p.ProfileId, WorkspaceID: p.WorkspaceId, RelativePath: p.RelativePath, ComputerGeneration: generation, BeforeSHA256: p.BeforeSHA256, SubmittedAt: p.SubmittedAt}, nil
}

// This adapter delegates to the sole existing owner engine and retained reader.
// Its publication map is accessed only within the ingress's serialized call.
type settingsDeliveryOutcomes struct{ root *SettingsDeliveryIngress }

func (o settingsDeliveryOutcomes) Execute(ctx context.Context, selected delivery.Selection, request delivery.EditRequest) (*delivery.Response, error) {
	publication, ok := o.root.publications[selected.OperationID]
	if !ok || publication.Generation != decimal(selected.ComputerGeneration) {
		return nil, delivery.ErrInvalid
	}
	computer := o.root.mutations.computer
	if selected.ProfileID != computer.peer.ProfileId || selected.OwnerID != computer.ownerID || selected.ComputerID != computer.computerID {
		return nil, delivery.ErrInvalid
	}
	edits := make([]wire.ComputerTextEdit, len(request.Operation.Edits))
	for i, edit := range request.Operation.Edits {
		edits[i] = wire.ComputerTextEdit{OldText: edit.OldText, NewText: edit.NewText}
	}
	result, err := o.root.mutations.edit(ctx, selected.OperationID, wire.ComputerSettingsEditRequest{Publication: publication, WorkspaceId: request.WorkspaceID, RelativePath: request.Operation.RelativePath, ExpectedSHA256: request.Operation.ExpectedSHA256, Edits: edits})
	return settingsDeliveryResponse(result, err)
}
func (o settingsDeliveryOutcomes) Observe(ctx context.Context, selected delivery.Selection, request delivery.Observation) (*delivery.Response, error) {
	computer := o.root.mutations.computer
	if selected.ProfileID != computer.peer.ProfileId || selected.OwnerID != computer.ownerID || selected.ComputerID != computer.computerID {
		return nil, delivery.ErrInvalid
	}
	result, err := o.root.mutations.observe(ctx, wire.ComputerSettingsMutationRead{OperationId: selected.OperationID, WorkspaceId: request.WorkspaceID, RelativePath: request.RelativePath, ComputerGeneration: decimal(selected.ComputerGeneration)})
	return settingsDeliveryResponse(result, err)
}
func settingsDeliveryResponse(v *wire.ComputerSettingsMutationResponse, err error) (*delivery.Response, error) {
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, delivery.ErrInvalid
	}
	generation, err := strconv.ParseUint(v.ComputerGeneration, 10, 64)
	if err != nil {
		return nil, delivery.ErrInvalid
	}
	out := &delivery.Response{OperationID: v.OperationId, WorkspaceID: v.WorkspaceId, ComputerGeneration: generation, Phase: v.Phase, Publication: v.Publication}
	if v.Receipt != nil {
		r := v.Receipt
		bytes, err := strconv.ParseUint(r.Bytes, 10, 64)
		if err != nil {
			return nil, delivery.ErrInvalid
		}
		var before *string
		if r.BeforeSHA256 != nil {
			copy := *r.BeforeSHA256
			before = &copy
		}
		out.Receipt = &delivery.EffectReceipt{Operation: r.Operation, RelativePath: r.RelativePath, Bytes: bytes, Replacements: r.Replacements, BeforeSHA256: before, AfterSHA256: r.AfterSHA256}
	}
	if v.Failure != nil {
		out.Failure = &delivery.Failure{Code: v.Failure.Code, Source: v.Failure.Source}
	}
	return out, nil
}
func settingsDeliveryResult(v *delivery.Response, pending delivery.Pending) (*wire.ComputerSettingsMutationResponse, error) {
	if v == nil {
		return nil, delivery.ErrInvalid
	}
	out := &mutationct.OwnerResponse{OperationID: v.OperationID, WorkspaceID: v.WorkspaceID, ComputerGeneration: v.ComputerGeneration, Phase: v.Phase, Publication: v.Publication}
	if r := v.Receipt; r != nil {
		out.Receipt = &mutationct.Receipt{Operation: r.Operation, RelativePath: r.RelativePath, Bytes: r.Bytes, Replacements: r.Replacements, BeforeSHA256: r.BeforeSHA256, AfterSHA256: r.AfterSHA256}
	}
	if f := v.Failure; f != nil {
		out.Failure = &mutationct.OutcomeFailure{Code: f.Code, Source: f.Source, Retry: "never"}
	}
	return settingsMutationResult(pending.OperationID, pending.WorkspaceID, pending.RelativePath, pending.ComputerGeneration, out)
}

// Observe includes offering an uncertainty result, which can durably invalidate
// verification. It is therefore an effect method with its own transport ID;
// the original edit ID remains inside Pending and is never dispatched again.
func (s *SettingsDeliveryIngress) Methods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.settings.delivery.apply": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.SettingsDeliveryApply
			if settingsDeliveryDecode("SettingsDeliveryApply", r, &in) != nil {
				return invalidIngress()
			}
			call, cancel, err := settingsDeliveryContext(ctx, in.DeadlineMillis)
			if err != nil {
				return invalidIngress()
			}
			defer cancel()
			out, err := s.apply(call, r.OperationID, in)
			return settingsDeliveryOutcome("SettingsDeliveryResult", out, err)
		}},
		"computer.settings.delivery.observe": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.SettingsDeliveryObserve
			if settingsDeliveryDecode("SettingsDeliveryObserve", r, &in) != nil {
				return invalidIngress()
			}
			call, cancel, err := settingsDeliveryContext(ctx, in.DeadlineMillis)
			if err != nil {
				return invalidIngress()
			}
			defer cancel()
			out, err := s.observe(call, in)
			return settingsDeliveryOutcome("SettingsDeliveryResult", out, err)
		}},
		"computer.settings.delivery.ack": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.SettingsDeliveryACK
			if settingsDeliveryDecode("SettingsDeliveryACK", r, &in) != nil {
				return invalidIngress()
			}
			call, cancel, err := settingsDeliveryContext(ctx, in.DeadlineMillis)
			if err != nil {
				return invalidIngress()
			}
			defer cancel()
			out, err := s.acknowledge(call, in)
			return settingsDeliveryOutcome("SettingsDeliveryACKResult", out, err)
		}},
	}
}
func settingsDeliveryDecode(shape string, r desktop.Request, value any) error {
	if !validIngressID(r.OperationID) || len(r.Body) > 512*1024 || ipc.ValidateJSON(r.Body) != nil || wire.Validate(shape, r.Body) != nil {
		return delivery.ErrInvalid
	}
	return json.Unmarshal(r.Body, value)
}
func settingsDeliveryOutcome(shape string, value any, err error) (*desktop.Outcome, error) {
	if err != nil {
		status, code := "unknown", "settings_delivery_unavailable"
		for _, classified := range []error{delivery.ErrInvalid, delivery.ErrConflict, delivery.ErrConsumed, delivery.ErrFenced, delivery.ErrNotWritten, delivery.ErrNotReady, delivery.ErrCapacity, delivery.ErrEffectUnsettled} {
			if errors.Is(err, classified) {
				code = classified.Error()
				break
			}
		}
		switch {
		case errors.Is(err, delivery.ErrInvalid), errors.Is(err, delivery.ErrConflict), errors.Is(err, delivery.ErrConsumed), errors.Is(err, delivery.ErrNotWritten), errors.Is(err, delivery.ErrCapacity):
			status = "refused"
		}
		return &desktop.Outcome{Status: status, Code: code}, nil
	}
	raw, err := json.Marshal(value)
	if err != nil || wire.Validate(shape, raw) != nil {
		return &desktop.Outcome{Status: "unknown", Code: "settings_delivery_result_invalid"}, nil
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}

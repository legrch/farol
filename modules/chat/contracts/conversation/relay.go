package conversation

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/admission"
)

// ComputerContext is correlation, not caller authority. Root associates the
// existing relay operation with the exact Handle; Chat checks the live owner.
type ComputerContext struct {
	Binding             Binding
	Physical            Prepared
	UserTurnID, ReplyID string
	SourceSequence      uint64
}
type ComputerReturn struct {
	Context  ComputerContext
	CallID   string
	Returned bool
}

// ComputerCall has no constructor accepting IDs, effect method or retry path.
// It represents a durable request belonging to one actual lifecycle handle.
type ComputerCall struct{ current *lifecycle.ComputerCall }

// Admission captures the existing current-owner projection from THIS handle.
// It neither admits work nor supplies Computer's separate permissions/leases.
func (h *Handle) Admission() (*admission.Current, error) {
	if h == nil || h.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	service, err := admissionsvc.New(h.current.AdmissionOwner())
	if err != nil {
		return nil, failure(lifecycle.Unavailable)
	}
	return admission.New(service), nil
}
func (h *Handle) ComputerContext(ctx context.Context) (*ComputerContext, error) {
	if h == nil || h.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	current, err := h.current.ComputerContext(ctx)
	if err != nil {
		return nil, failure(err)
	}
	out := fromComputerContext(*current)
	return &out, nil
}
func (h *Handle) BeginComputer(ctx context.Context, correlation ComputerContext, callID string) (*ComputerCall, error) {
	if h == nil || h.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	// Physical's duplicated logical binding must match; do not drop unknown or
	// changed boundary data during mapping.
	if correlation.Physical.Binding != correlation.Binding {
		return nil, failure(lifecycle.Mismatch)
	}
	current, err := h.current.BeginComputer(ctx, toComputerContext(correlation), callID)
	if err != nil {
		return nil, failure(err)
	}
	return &ComputerCall{current: current}, nil
}
func (call *ComputerCall) AcknowledgeReturn(ctx context.Context, ack *ComputerReturn) error {
	if call == nil || call.current == nil {
		return failure(lifecycle.Invalid)
	}
	var mapped *port.ComputerReturn
	if ack != nil {
		if ack.Context.Physical.Binding != ack.Context.Binding {
			return failure(lifecycle.Mismatch)
		}
		mapped = &port.ComputerReturn{Context: toComputerContext(ack.Context), CallID: ack.CallID, Returned: ack.Returned}
	}
	return failure(call.current.AcknowledgeReturn(ctx, mapped))
}
func fromComputerContext(c port.ComputerContext) ComputerContext {
	b := c.Browser
	return ComputerContext{Binding: fromBinding(c.Binding), Physical: Prepared{Binding: fromBinding(c.Binding), ProviderState: string(b.ProviderState), SlotOrdinal: b.Lease.SlotOrdinal, SlotGeneration: b.Lease.SlotGeneration, ViewID: b.ViewID, ViewGeneration: b.ViewGeneration, DocumentGeneration: b.DocumentGeneration, ConversationID: b.ConversationID}, UserTurnID: c.UserTurnID, ReplyID: c.ReplyID, SourceSequence: c.SourceSequence}
}
func toComputerContext(c ComputerContext) port.ComputerContext {
	p, b := c.Physical, toBinding(c.Binding)
	return port.ComputerContext{Binding: b, Browser: port.BrowserBinding{ProviderState: port.ProviderState(p.ProviderState), Lease: port.BrowserLease{Identity: port.RequestIdentity{ProfileID: b.ProfileID, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TurnID: b.TurnID, OperationID: b.OperationID, TurnGeneration: b.TurnGeneration}, BackendGeneration: b.BackendGeneration, SlotOrdinal: p.SlotOrdinal, SlotGeneration: p.SlotGeneration}, ViewID: p.ViewID, ViewGeneration: p.ViewGeneration, DocumentGeneration: p.DocumentGeneration, ConversationID: p.ConversationID}, UserTurnID: c.UserTurnID, ReplyID: c.ReplyID, SourceSequence: c.SourceSequence}
}

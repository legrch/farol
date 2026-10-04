package conversation

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
)

// Independent consumer DTOs. Trusted composition supplies the original resolved
// catalogue entry and binds external identity to THIS actual admitted handle.
type CallerScope struct{ SessionID, ThreadID, TurnID, RootTurnID, Model string }
type CallerFunctionCall struct {
	ItemID, CallID, Name, Arguments string
	Namespace                       *string
}
type BeginCallerToolRequest struct {
	Context             ComputerContext
	Scope               CallerScope
	ProducerOperationID string
	Call                CallerFunctionCall
}
type CallerFunctionOutput struct {
	CallID string
	Raw    []byte
}
type AcceptCallerOutputRequest struct {
	Context ComputerContext
	Scope   CallerScope
	Calls   []CallerFunctionCall
	Outputs []CallerFunctionOutput
}
type CallerOutput struct {
	Output, SHA256 string
	Bytes          uint64
}
type CallerReturn struct {
	Context                                   ComputerContext
	ProducerOperationID, CallID, OutputSHA256 string
	OutputBytes                               uint64
	Returned                                  bool
}

// The token has no constructor accepting IDs, executor or replacement route.
// Internal Go Computer reads use their existing ComputerCall, never this facade.
type CallerToolCall struct{ current *lifecycle.CallerToolCall }

func toCallerScope(s CallerScope) port.CallerScope {
	return port.CallerScope{SessionID: s.SessionID, ThreadID: s.ThreadID, TurnID: s.TurnID, RootTurnID: s.RootTurnID, Model: s.Model}
}
func toCallerFunction(c CallerFunctionCall) port.CallerFunctionCall {
	out := port.CallerFunctionCall{ItemID: c.ItemID, CallID: c.CallID, Name: c.Name, Arguments: c.Arguments}
	if c.Namespace != nil {
		n := *c.Namespace
		out.Namespace = &n
	}
	return out
}
func (h *Handle) BeginCallerTool(ctx context.Context, input BeginCallerToolRequest) (*CallerToolCall, error) {
	if h == nil || h.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	if input.Context.Physical.Binding != input.Context.Binding {
		return nil, failure(lifecycle.Mismatch)
	}
	call, err := h.current.BeginCallerTool(ctx, port.BeginCallerToolRequest{Context: toComputerContext(input.Context), Scope: toCallerScope(input.Scope), ProducerOperationID: input.ProducerOperationID, Call: toCallerFunction(input.Call)})
	if err != nil {
		return nil, failure(err)
	}
	return &CallerToolCall{current: call}, nil
}
func (call *CallerToolCall) AcceptOutput(ctx context.Context, input AcceptCallerOutputRequest) (*CallerOutput, error) {
	if call == nil || call.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	if input.Context.Physical.Binding != input.Context.Binding {
		return nil, failure(lifecycle.Mismatch)
	}
	mapped := port.AcceptCallerOutputRequest{Context: toComputerContext(input.Context), Scope: toCallerScope(input.Scope)}
	for _, c := range input.Calls {
		mapped.Calls = append(mapped.Calls, toCallerFunction(c))
	}
	for _, o := range input.Outputs {
		mapped.Outputs = append(mapped.Outputs, port.CallerFunctionOutput{CallID: o.CallID, Raw: append([]byte(nil), o.Raw...)})
	}
	out, err := call.current.AcceptOutput(ctx, mapped)
	if err != nil {
		return nil, failure(err)
	}
	return &CallerOutput{Output: out.Output, SHA256: out.SHA256, Bytes: out.Bytes}, nil
}
func (call *CallerToolCall) AcknowledgeReturn(ctx context.Context, ack *CallerReturn) error {
	if call == nil || call.current == nil {
		return failure(lifecycle.Invalid)
	}
	var mapped *port.CallerReturn
	if ack != nil {
		if ack.Context.Physical.Binding != ack.Context.Binding {
			return failure(lifecycle.Mismatch)
		}
		mapped = &port.CallerReturn{Context: toComputerContext(ack.Context), ProducerOperationID: ack.ProducerOperationID, CallID: ack.CallID, OutputSHA256: ack.OutputSHA256, OutputBytes: ack.OutputBytes, Returned: ack.Returned}
	}
	return failure(call.current.AcknowledgeReturn(ctx, mapped))
}

// Claim once for compatibility/settlement. The selected HTTP path must obtain
// IssueDelivery before its executable write; snapshots/Events are not permits.
// Never claim or issue again after loss.
func (call *CallerToolCall) ClaimDispatch(ctx context.Context) error {
	if call == nil || call.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(call.current.ClaimDispatch(ctx))
}

// CheckDispatch is a read-only snapshot of the SAME claimed pending call. It is
// not a transport mutex/fence, executable replay permission or a second claim.
// A consumer must still fence the original transport across cancellation,
// freeze and awaited writes/drains; success cannot outlive this observation.
func (call *CallerToolCall) CheckDispatch(ctx context.Context) error {
	if call == nil || call.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(call.current.CheckDispatch(ctx))
}

func fromCallerScope(s port.CallerScope) CallerScope {
	return CallerScope{SessionID: s.SessionID, ThreadID: s.ThreadID, TurnID: s.TurnID, RootTurnID: s.RootTurnID, Model: s.Model}
}
func fromCallerFunction(c port.CallerFunctionCall) CallerFunctionCall {
	out := CallerFunctionCall{ItemID: c.ItemID, CallID: c.CallID, Name: c.Name, Arguments: c.Arguments}
	if c.Namespace != nil {
		n := *c.Namespace
		out.Namespace = &n
	}
	return out
}

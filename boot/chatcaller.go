package boot

import (
	"context"
	"encoding/json"
	"errors"
	wire "github.com/legrch/farol/gen/desktop/v1"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
	"sync"
)

type chatCallerRecord struct {
	token                                                 wire.ChatCallerHandle
	correlation                                           conversation.ComputerContext
	call                                                  *conversation.CallerToolCall
	claimed, claimKnown, outputAttempted, returnAttempted bool
	receipt                                               *wire.ChatCallerReceipt
	issueAttempted                                        bool
}

// This table retains opaque owner handles only. The existing Chat owner owns
// the external tool round, retained frames and settlement. It never executes a
// caller tool or selects a Computer executor. Body IDs supply correlation only.
type chatCallerIngress struct {
	mu      sync.Mutex
	chat    *ChatIngress
	records map[string]*chatCallerRecord
	handles map[string]bool
}

func newChatCallerIngress(chat *ChatIngress) *chatCallerIngress {
	return &chatCallerIngress{chat: chat, records: make(map[string]*chatCallerRecord), handles: make(map[string]bool)}
}
func callerScope(s wire.ChatCallerScope) conversation.CallerScope {
	return conversation.CallerScope{SessionID: s.SessionId, ThreadID: s.ThreadId, TurnID: s.TurnId, RootTurnID: s.RootTurnId, Model: s.Model}
}
func callerFunction(c wire.ChatCallerFunction) conversation.CallerFunctionCall {
	return conversation.CallerFunctionCall{ItemID: c.ItemId, CallID: c.CallId, Name: c.Name, Arguments: c.Arguments, Namespace: c.Namespace}
}
func (s *chatCallerIngress) begin(ctx context.Context, input wire.ChatCallerBegin) (*wire.ChatCallerHandle, error) {
	h, err := s.chat.get(input.HandleId)
	if err != nil {
		return nil, err
	}
	correlation, err := h.handle.ComputerContext(ctx)
	if err != nil {
		return nil, err
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	token := wire.ChatCallerHandle{TicketId: id, HandleId: input.HandleId, ProducerOperationId: input.ProducerOperationId, CallId: input.Call.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256}
	record := &chatCallerRecord{token: token, correlation: *correlation}
	s.mu.Lock()
	if s.handles[input.HandleId] || len(s.records) >= 1024 {
		s.mu.Unlock()
		return nil, errors.New("chat_caller_already_selected")
	}
	// Keep the tombstone even when original publication is unknown. Never adopt
	// a replacement call/token/route on the same handle after that boundary.
	s.handles[input.HandleId] = true
	s.records[id] = record
	s.mu.Unlock()
	call, err := h.handle.BeginCallerTool(ctx, conversation.BeginCallerToolRequest{Context: *correlation, Scope: callerScope(input.Scope), ProducerOperationID: input.ProducerOperationId, Call: callerFunction(input.Call)})
	if err != nil {
		return nil, err
	}
	if call == nil {
		return nil, errors.New("chat_caller_begin_unknown")
	}
	s.mu.Lock()
	record.call = call
	s.mu.Unlock()
	return &token, nil
}
func (s *chatCallerIngress) current(token wire.ChatCallerHandle) (*chatCallerRecord, error) {
	record := s.records[token.TicketId]
	if record == nil || record.call == nil || record.token != token {
		return nil, errors.New("chat_caller_handle_crossed")
	}
	return record, nil
}

// This observation grants no write permit and cannot repeat the original claim.
func (s *chatCallerIngress) check(ctx context.Context, token wire.ChatCallerHandle) error {
	s.mu.Lock()
	record, err := s.current(token)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return record.call.CheckDispatch(ctx)
}

func (s *chatCallerIngress) claim(ctx context.Context, token wire.ChatCallerHandle) error {
	s.mu.Lock()
	record, err := s.current(token)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if record.claimed {
		s.mu.Unlock()
		return errors.New("chat_caller_dispatch_already_claimed")
	}
	record.claimed = true
	s.mu.Unlock()
	if err = record.call.ClaimDispatch(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	record.claimKnown = true
	s.mu.Unlock()
	return nil
}
func (s *chatCallerIngress) output(ctx context.Context, input wire.ChatCallerAccept) (*wire.ChatCallerOutput, error) {
	if len(input.Calls) != 1 || len(input.Outputs) != 1 {
		return nil, errors.New("chat_caller_cardinality_invalid")
	}
	s.mu.Lock()
	record, err := s.current(input.Handle)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if !record.claimKnown || record.outputAttempted {
		s.mu.Unlock()
		return nil, errors.New("chat_caller_output_unavailable")
	}
	record.outputAttempted = true
	s.mu.Unlock()
	out, err := record.call.AcceptOutput(ctx, conversation.AcceptCallerOutputRequest{Context: record.correlation, Scope: callerScope(input.Scope), Calls: []conversation.CallerFunctionCall{callerFunction(input.Calls[0])}, Outputs: []conversation.CallerFunctionOutput{{CallID: input.Outputs[0].CallId, Raw: append([]byte(nil), input.Outputs[0].Raw...)}}})
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, errors.New("chat_caller_output_unknown")
	}
	receiptID, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	receipt := wire.ChatCallerReceipt{ReceiptId: receiptID, Handle: record.token, OutputSHA256: out.SHA256, OutputBytes: decimal(out.Bytes)}
	result := &wire.ChatCallerOutput{Receipt: receipt, Output: out.Output}
	if validateIngress("ChatCallerOutput", result) != nil {
		return nil, errors.New("chat_caller_output_invalid")
	}
	s.mu.Lock()
	record.receipt = &receipt
	s.mu.Unlock()
	return result, nil
}
func (s *chatCallerIngress) returned(ctx context.Context, receipt wire.ChatCallerReceipt) error {
	s.mu.Lock()
	record, err := s.current(receipt.Handle)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if record.receipt == nil || *record.receipt != receipt || record.returnAttempted {
		s.mu.Unlock()
		return errors.New("chat_caller_return_unavailable")
	}
	record.returnAttempted = true
	s.mu.Unlock()
	return record.call.AcknowledgeReturn(ctx, &conversation.CallerReturn{Context: record.correlation, ProducerOperationID: record.token.ProducerOperationId, CallID: record.token.CallId, OutputSHA256: receipt.OutputSHA256, OutputBytes: wireUint(receipt.OutputBytes), Returned: true})
}
func (s *chatCallerIngress) Methods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.caller.issue": s.issueMethod(),
		"chat.caller.check": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatCallerHandle
			if r.OperationID != "" || chatDecode("ChatCallerHandle", r, &in) != nil {
				return invalidIngress()
			}
			return chatOutcome("Empty", wire.Empty{}, s.check(ctx, in))
		}},
		"chat.caller.begin": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatCallerBegin
			if r.OperationID == "" || chatDecode("ChatCallerBegin", r, &in) != nil {
				return invalidIngress()
			}
			v, e := s.begin(ctx, in)
			return chatOutcome("ChatCallerHandle", v, e)
		}},
		"chat.caller.claim": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatCallerHandle
			if r.OperationID == "" || chatDecode("ChatCallerHandle", r, &in) != nil {
				return invalidIngress()
			}
			return chatOutcome("Empty", wire.Empty{}, s.claim(ctx, in))
		}},
		"chat.caller.output": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatCallerAccept
			if r.OperationID == "" || chatDecode("ChatCallerAccept", r, &in) != nil {
				return invalidIngress()
			}
			v, e := s.output(ctx, in)
			if e != nil {
				return nil, e
			}
			out, e := chatOutcome("ChatCallerOutput", v, nil)
			if e != nil {
				return nil, e
			}
			// Normalized output plus JSON escaping and common framing must fit before
			// transport publication; a failed bound never acknowledges its recipient.
			operation := r.OperationID
			raw, e := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &r.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: r.RequestID, Context: s.chat.peer, OperationId: &operation, Data: out.Data}})
			if e != nil || len(raw) > ipc.MaxFrameBytes {
				return nil, errors.New("chat_caller_frame_bound")
			}
			return out, nil
		}},
		"chat.caller.return": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatCallerReceipt
			if r.OperationID == "" || chatDecode("ChatCallerReceipt", r, &in) != nil {
				return invalidIngress()
			}
			return chatOutcome("Empty", wire.Empty{}, s.returned(ctx, in))
		}},
	}
}

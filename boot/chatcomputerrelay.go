package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type chatComputerKey struct{ handle, call string }
type chatComputerReturn struct {
	mutation    *computerMutationOperation
	receipt     wire.ChatComputerReceipt
	correlation conversation.ComputerContext
	call        *conversation.ComputerCall
	attempted   bool
	settled     bool
}

type chatComputerTurn struct {
	binding conversation.Binding
	route   *ComputerRoute
	last    *chatComputerReturn
}

// ChatComputerIngress retains opaque handles for the one existing Chat/Computer
// join. It owns neither an executor nor a queue. The inherited desktop channel
// may return only a receipt captured by its trusted relay client's actual parser;
// model arguments, socket writes and history are not receipt producers.
type ChatComputerIngress struct {
	mu        sync.Mutex
	chat      *ChatIngress
	computer  *ComputerIngress
	mutations computerMutationDependencies
	calls     map[chatComputerKey]*chatComputerReturn
	turns     map[*conversation.Handle]*chatComputerTurn
}

func NewChatComputerIngress(chat *ChatIngress, computer *ComputerIngress) (*ChatComputerIngress, error) {
	if chat == nil || computer == nil || chat.facade == nil || chat.peer != computer.peer || chat.owner != computer.ownerID {
		return nil, computerUnavailable()
	}
	return &ChatComputerIngress{chat: chat, computer: computer, calls: make(map[chatComputerKey]*chatComputerReturn), turns: make(map[*conversation.Handle]*chatComputerTurn)}, nil
}

func (s *ChatComputerIngress) read(ctx context.Context, operation string, input wire.ChatComputerRead) (*wire.ChatComputerOutput, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatComputerRead", input) != nil {
		return nil, computerUnavailable()
	}
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
	key := chatComputerKey{input.HandleId, input.CallId}
	record := &chatComputerReturn{}
	s.mu.Lock()
	if _, exists := s.calls[key]; exists || len(s.calls) >= 1024 {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	turn := s.turns[h.handle]
	if turn != nil && (turn.binding != h.binding || turn.last == nil || !turn.last.settled) {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	if turn == nil {
		turn = &chatComputerTurn{binding: h.binding}
		s.turns[h.handle] = turn
	}
	// Reserve both identities before any effect. An attempted return or an
	// observed cleared owner is not the original known Root receipt. Failed or
	// unknown work leaves this exact chain closed without restoration.
	s.calls[key] = record
	turn.last = record
	selected := turn.route
	s.mu.Unlock()
	output, call, selected, err := s.computer.readConversationOnRoute(ctx, h.handle, *correlation, operation, input.CallId, input.WorkspaceId, input.RelativePath, selected)
	if err != nil {
		return nil, err
	}
	if output == nil || call == nil || ctx.Err() != nil {
		return nil, errors.New("chat_computer_result_unknown")
	}
	b := correlation.Binding
	if output.OwnerID != b.OwnerID || output.SessionID != b.SessionID || output.TaskID != b.TaskID || output.TaskEpoch != b.TaskEpoch || output.ParticipantID != b.ParticipantID || output.TurnID != b.TurnID || output.Generation != b.TurnGeneration || output.CallID != input.CallId || output.WorkspaceID != input.WorkspaceId || output.RelativePath != input.RelativePath || output.Page != nil {
		return nil, errors.New("chat_computer_result_crossed")
	}
	value := wire.ComputerReadResponse{OwnerId: output.OwnerID, SessionId: output.SessionID, TaskId: output.TaskID, TaskEpoch: decimal(output.TaskEpoch), ParticipantId: output.ParticipantID, TurnId: output.TurnID, Generation: decimal(output.Generation), CallId: output.CallID, WorkspaceId: output.WorkspaceID, RelativePath: output.RelativePath, Text: output.Text, Bytes: decimal(output.Bytes), Sha256: output.SHA256}
	raw, err := json.Marshal(value)
	if err != nil || wire.Validate("ComputerReadResponse", raw) != nil || len(raw) > 512*1024 {
		return nil, errors.New("chat_computer_output_invalid")
	}
	hash := sha256.Sum256(raw)
	receipt := wire.ChatComputerReceipt{ReceiptId: id, HandleId: input.HandleId, CallId: input.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256, OutputSHA256: hex.EncodeToString(hash[:]), OutputBytes: decimal(uint64(len(raw)))}
	result := &wire.ChatComputerOutput{Receipt: receipt, Output: string(raw)}
	if validateIngress("ChatComputerOutput", result) != nil {
		return nil, errors.New("chat_computer_output_invalid")
	}
	s.mu.Lock()
	record.receipt, record.correlation, record.call = receipt, *correlation, call
	// Key by the actual opaque handle, never a task ID supplied by a caller.
	// Selection retains the original ceiling/current owner; every operation
	// reacquires its own lease from the live Computer and Chat owners.
	turn.route = selected
	s.mu.Unlock()
	return result, nil
}

func (s *ChatComputerIngress) returned(ctx context.Context, receipt wire.ChatComputerReceipt) error {
	if s == nil || ctx == nil || ctx.Err() != nil || validateIngress("ChatComputerReceipt", receipt) != nil {
		return computerUnavailable()
	}
	s.mu.Lock()
	record := s.calls[chatComputerKey{receipt.HandleId, receipt.CallId}]
	if record == nil || record.call == nil || record.receipt != receipt || record.attempted {
		s.mu.Unlock()
		return computerUnavailable()
	}
	// Claim before calling the owner. A lost Resolve journal ACK is never retried
	// with another transport operation, even if the write actually committed.
	record.attempted = true
	call, correlation := record.call, record.correlation
	s.mu.Unlock()
	if err := call.AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: correlation, CallID: receipt.CallId, Returned: true}); err != nil {
		return err
	}
	s.mu.Lock()
	record.settled = true
	s.mu.Unlock()
	return nil
}

func (s *ChatComputerIngress) Methods() map[string]desktop.Method {
	methods := map[string]desktop.Method{
		"chat.computer.read": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatComputerRead
			if r.OperationID == "" || chatDecode("ChatComputerRead", r, &in) != nil {
				return invalidIngress()
			}
			v, e := s.read(ctx, r.OperationID, in)
			if e != nil {
				return nil, e
			}
			result, e := chatOutcome("ChatComputerOutput", v, nil)
			if e != nil {
				return nil, e
			}
			// Nested JSON escaping and the exact common envelope are bounded
			// before the transport writes. A failed bound never creates an ACK.
			operation := r.OperationID
			raw, e := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &r.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: r.RequestID, Context: s.chat.peer, OperationId: &operation, Data: result.Data}})
			if e != nil || len(raw) > ipc.MaxFrameBytes {
				return nil, errors.New("chat_computer_frame_bound")
			}
			return result, nil
		}},
		"chat.computer.return": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatComputerReceipt
			if r.OperationID == "" || chatDecode("ChatComputerReceipt", r, &in) != nil {
				return invalidIngress()
			}
			e := s.returned(ctx, in)
			return chatOutcome("Empty", wire.Empty{}, e)
		}},
	}
	for name, method := range s.mutationMethods() {
		methods[name] = method
	}
	return methods
}

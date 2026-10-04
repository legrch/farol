package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/infra/responses"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Root binds one actual-owner issuance to exact encoded bytes. Neither reading
// Events nor a successful socket write can mint this ticket or acknowledge it.
func (s *chatCallerIngress) issue(ctx context.Context, token wire.ChatCallerHandle) (*wire.ChatCallerDelivery, error) {
	s.mu.Lock()
	record, err := s.current(token)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if !record.claimKnown || record.issueAttempted {
		s.mu.Unlock()
		return nil, errors.New("chat_caller_issue_unavailable")
	}
	record.issueAttempted = true
	s.mu.Unlock()
	// Never hold Root's table mutex across the actual owner gate or any IO.
	issued, err := record.call.IssueDelivery(ctx)
	if err != nil {
		return nil, err
	}
	if issued == nil || issued.Context != record.correlation || issued.ProducerOperationID != token.ProducerOperationId || issued.Call.CallID != token.CallId || issued.FirstSequence == 0 || issued.LastSequence < issued.FirstSequence || issued.LastSequence-issued.FirstSequence >= 128 || uint64(len(issued.Frames)) != issued.LastSequence-issued.FirstSequence+1 {
		return nil, errors.New("chat_caller_issue_crossed")
	}
	var data []byte
	for n, frame := range issued.Frames {
		if frame.Sequence != issued.FirstSequence+uint64(n) {
			return nil, errors.New("chat_caller_issue_gap")
		}
		encoded, err := responses.Encode(frame)
		if err != nil {
			return nil, err
		}
		if len(data)+len(encoded) > 512*1024 {
			return nil, errors.New("chat_caller_issue_bound")
		}
		data = append(data, encoded...)
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	out := &wire.ChatCallerDelivery{IssuanceId: id, Handle: token, FirstSequence: decimal(issued.FirstSequence), LastSequence: decimal(issued.LastSequence), Data: string(data), DataSHA256: hex.EncodeToString(sum[:]), DataBytes: decimal(uint64(len(data)))}
	if validateIngress("ChatCallerDelivery", out) != nil {
		return nil, errors.New("chat_caller_issue_invalid")
	}
	return out, nil
}
func (s *chatCallerIngress) issueMethod() desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatCallerHandle
		if r.OperationID == "" || chatDecode("ChatCallerHandle", r, &in) != nil {
			return invalidIngress()
		}
		value, err := s.issue(ctx, in)
		if err != nil {
			return nil, err
		}
		out, err := chatOutcome("ChatCallerDelivery", value, nil)
		if err != nil {
			return nil, err
		}
		operation := r.OperationID
		raw, err := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &r.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: r.RequestID, Context: s.chat.peer, OperationId: &operation, Data: out.Data}})
		if err != nil || len(raw) > ipc.MaxFrameBytes {
			return nil, errors.New("chat_caller_frame_bound")
		}
		return out, nil
	}}
}

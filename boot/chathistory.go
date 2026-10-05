package boot

import (
	"context"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/transport/desktop"
)

// This read-only adapter has no live-handle registry or execution methods.
// The facade performs current authority and exact ancestor qualification.
type historicalConversations interface {
	List(context.Context, uint32) (*conversation.HistoryPage, error)
	Read(context.Context, conversation.HistoryKey) (*conversation.Result, error)
}

func historyOutcome(shape string, value any, err error) (*desktop.Outcome, error) {
	if err == nil {
		return chatOutcome(shape, value, nil)
	}
	status, code := "unknown", "CHAT_HISTORY_UNAVAILABLE"
	var failure *conversation.Failure
	if errors.As(err, &failure) {
		code = failure.Code
		if code == "CHAT_HANDOFF_INVALID" || code == "CHAT_HANDOFF_REFUSED" {
			status = "refused"
		}
	}
	return &desktop.Outcome{Status: status, Code: code}, nil
}
func chatHistoryMethods(history historicalConversations) map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.history.list": {Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatHistoryListRequest
			if request.OperationID != "" || chatDecode("ChatHistoryListRequest", request, &in) != nil {
				return invalidIngress()
			}
			p, err := history.List(ctx, in.Offset)
			if err != nil {
				return historyOutcome("", nil, err)
			}
			out := wire.ChatHistoryPage{Offset: p.Offset, Total: p.Total, Entries: make([]wire.ChatHistorySummary, 0, len(p.Entries))}
			for _, e := range p.Entries {
				out.Entries = append(out.Entries, wire.ChatHistorySummary{Key: wire.ChatHistoryKey{BackendGeneration: e.Key.BackendGeneration, OperationId: e.Key.OperationID}, Binding: chatWireBinding(e.Binding), ResultId: e.ResultID, ConversationId: e.ConversationID})
			}
			return historyOutcome("ChatHistoryPage", out, nil)
		}},
		"chat.history.result": {Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatHistoryKey
			if request.OperationID != "" || chatDecode("ChatHistoryKey", request, &in) != nil {
				return invalidIngress()
			}
			v, err := history.Read(ctx, conversation.HistoryKey{BackendGeneration: in.BackendGeneration, OperationID: in.OperationId})
			if err != nil {
				return historyOutcome("", nil, err)
			}
			return historyOutcome("ChatHistoryResult", wire.ChatHistoryResult{Key: in, Binding: chatWireBinding(v.Binding), ConversationId: v.ConversationID, UserTurnId: v.UserTurnID, ReplyId: v.ReplyID, ResultId: v.ResultID, Evidence: chatWireEvidence(v.Evidence), Phase: v.Phase, Outcome: v.Outcome, Code: v.Code, Text: v.Text, Complete: v.Complete, Acknowledged: v.Acknowledged}, nil)
		}},
	}
}

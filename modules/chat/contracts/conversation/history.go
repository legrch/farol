package conversation

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

// History exposes retained ancestor results under a current read authority. It
// cannot create a Handle or grant Send, Follow, resume or acknowledgement.
type History struct{ reader *handoff.HistoryReader }
type HistoryKey struct{ BackendGeneration, OperationID string }
type HistorySummary struct {
	Key                      HistoryKey
	Binding                  Binding
	ResultID, ConversationID string
}
type HistoryPage struct {
	Offset, Total uint32
	Entries       []HistorySummary
}

func NewHistory(reader *handoff.HistoryReader) *History { return &History{reader: reader} }
func historyFailure(err error) error {
	if err == nil {
		return nil
	}
	code := "CHAT_HISTORY_UNAVAILABLE"
	var classified handoff.Code
	if errors.As(err, &classified) {
		code = string(classified)
	}
	return &Failure{Code: code, Source: "chat-history", Retry: "never"}
}
func (h *History) List(ctx context.Context, offset uint32) (*HistoryPage, error) {
	if h == nil || h.reader == nil {
		return nil, historyFailure(handoff.Refused)
	}
	p, err := h.reader.List(ctx, offset)
	if err != nil {
		return nil, historyFailure(err)
	}
	out := &HistoryPage{Offset: p.Offset, Total: p.Total, Entries: make([]HistorySummary, 0, len(p.Entries))}
	for _, e := range p.Entries {
		out.Entries = append(out.Entries, HistorySummary{Key: HistoryKey{BackendGeneration: e.Key.BackendGeneration, OperationID: e.Key.OperationID}, Binding: fromBinding(e.Binding), ResultID: e.ResultID, ConversationID: e.ProviderConversationID})
	}
	return out, nil
}
func (h *History) Read(ctx context.Context, key HistoryKey) (*Result, error) {
	if h == nil || h.reader == nil {
		return nil, historyFailure(handoff.Refused)
	}
	r, err := h.reader.Read(ctx, port.HistoryKey{BackendGeneration: key.BackendGeneration, OperationID: key.OperationID})
	if err != nil {
		return nil, historyFailure(err)
	}
	return historyResult(*r), nil
}
func historyResult(r port.ConversationResult) *Result {
	return &Result{Binding: fromBinding(r.Binding), ConversationID: r.ProviderConversationID, UserTurnID: r.ProviderUserTurnID, ReplyID: r.ProviderReplyID, ResultID: r.ResultID, Requested: fromSelection(r.Requested), Observed: fromFacts(r.Observed), Text: r.Text, Evidence: fromEvidence(r.Evidence), Phase: r.Phase, Outcome: r.Outcome, Code: r.Code, Complete: r.Complete, Acknowledged: r.Acknowledged}
}

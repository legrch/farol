package boot

import (
	"context"
	"encoding/json"
	"testing"

	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/transport/desktop"
)

type historyIngressFixture struct{ calls int }

func (s *historyIngressFixture) List(context.Context, uint32) (*conversation.HistoryPage, error) {
	s.calls++
	return &conversation.HistoryPage{Entries: []conversation.HistorySummary{}}, nil
}
func (s *historyIngressFixture) Read(context.Context, conversation.HistoryKey) (*conversation.Result, error) {
	s.calls++
	return nil, &conversation.Failure{Code: "CHAT_HANDOFF_REFUSED", Source: "chat-history", Retry: "never"}
}
func TestHistoryIngressRejectsEffectsAndRequestSelectedAuthority(t *testing.T) {
	s := &historyIngressFixture{}
	methods := chatHistoryMethods(s)
	for _, tc := range []struct{ method, body, operation string }{
		{"list", `{"offset":0}`, "effect"}, {"list", `{"offset":1025}`, ""}, {"list", `{"offset":0,"ownerId":"other"}`, ""},
		{"result", `{"backendGeneration":"old","operationId":"op","profileId":"other"}`, ""},
		{"result", `{"backendGeneration":"old","operationId":"op"}`, "effect"},
	} {
		out, err := methods["chat.history."+tc.method].Handle(context.Background(), desktop.Request{Body: json.RawMessage(tc.body), OperationID: tc.operation})
		if err != nil || out == nil || out.Status != "refused" || s.calls != 0 {
			t.Fatal("invalid request reached history", err, out)
		}
	}
	out, err := methods["chat.history.list"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{"offset":0}`)})
	if err != nil || out.Status != "ok" || string(out.Data) != `{"offset":0,"total":0,"entries":[]}` || s.calls != 1 {
		t.Fatal("empty history not exact", err, out)
	}
	out, err = methods["chat.history.result"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{"backendGeneration":"old","operationId":"op"}`)})
	if err != nil || out.Status != "refused" || len(out.Data) != 0 || s.calls != 2 {
		t.Fatal("refusal became data", err, out)
	}
}

package desktop

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func historyFixture(t *testing.T) ChatHistoryResult {
	t.Helper()
	raw, err := os.ReadFile("../../../api/desktop/v1/fixtures/chat-history.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate("ChatHistoryResult", raw); err != nil {
		t.Fatal(err)
	}
	var result ChatHistoryResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func TestHistoryWireClosedIdentityAndBounds(t *testing.T) {
	r := historyFixture(t)
	if r.Binding.TaskEpoch != "9007199254740993" || r.Binding.TurnGeneration != "18446744073709551615" {
		t.Fatal("lossy original counters")
	}
	for _, m := range []string{"chat.history.list", "chat.history.result"} {
		if !KnownMethod(m) || RequiresOperationID(m) {
			t.Fatal("history classified as effect")
		}
	}
	for _, n := range []int{0, 32, 33} {
		p := ChatHistoryPage{Total: uint32(n), Entries: make([]ChatHistorySummary, n)}
		for i := range p.Entries {
			p.Entries[i] = ChatHistorySummary{Key: r.Key, Binding: r.Binding, ResultId: r.ResultId, ConversationId: r.ConversationId}
		}
		raw, _ := json.Marshal(p)
		if (Validate("ChatHistoryPage", raw) == nil) != (n <= 32) {
			t.Fatal("page bound changed", n)
		}
	}
	for _, text := range []string{strings.Repeat("x", 8191), strings.Repeat("x", 8192), strings.Repeat("x", 8193), strings.Repeat("☀", 2730) + "xx", strings.Repeat("☀", 2731)} {
		r.Text = text
		raw, _ := json.Marshal(r)
		if (Validate("ChatHistoryResult", raw) == nil) != (len(text) <= 8192) {
			t.Fatal("UTF-8 output bound changed", len(text))
		}
	}
	for _, raw := range []string{`{"offset":1025}`, `{"offset":-1}`, `{"offset":0,"ownerId":"other"}`} {
		if Validate("ChatHistoryListRequest", []byte(raw)) == nil {
			t.Fatal("invalid history request")
		}
	}
	r = historyFixture(t)
	raw, _ := json.Marshal(r)
	var v map[string]any
	_ = json.Unmarshal(raw, &v)
	v["handle"] = map[string]any{"handleId": "forged", "binding": r.Binding}
	raw, _ = json.Marshal(v)
	if Validate("ChatHistoryResult", raw) == nil {
		t.Fatal("historical data accepted live handle")
	}
}

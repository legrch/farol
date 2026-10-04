package responses_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/responses"
)

func TestCallerArgumentsEventsUseExistingEncoder(t *testing.T) {
	for _, kind := range []string{"response.function_call_arguments.delta", "response.function_call_arguments.done"} {
		t.Run(kind, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"type": kind, "sequence_number": uint64(19), "item_id": "fc-original", "output_index": 1, "arguments": `{"cmd":"exact"}`})
			encoded, err := responses.Encode(conversation.Frame{Sequence: 19, Type: kind, JSON: raw})
			if err != nil || !strings.HasPrefix(string(encoded), "event: "+kind+"\ndata: ") || !strings.HasSuffix(string(encoded), "\n\n") {
				t.Fatal("SSE changed")
			}
			for _, f := range []conversation.Frame{{Sequence: 20, Type: kind, JSON: raw}, {Sequence: 19, Type: "response.tool_exec", JSON: raw}, {Sequence: 19, Type: kind, JSON: []byte(`{`)}, {Sequence: 19, Type: kind, JSON: []byte(strings.Repeat("x", 64*1024+1))}} {
				if _, err := responses.Encode(f); err == nil {
					t.Fatal("invalid frame accepted")
				}
			}
		})
	}
}

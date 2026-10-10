package planresponses

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

func event(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return "data: " + string(raw) + "\n\n"
}
func created(id string) string {
	return event(map[string]any{"type": "response.created", "response": map[string]any{"id": id, "status": "in_progress"}})
}
func delta(text string) string {
	return event(map[string]any{"type": "response.output_text.delta", "delta": text})
}
func terminal(id, status string) string {
	return event(map[string]any{"type": "response." + status, "response": map[string]any{"id": id, "status": status}})
}

type fragmentReader struct {
	source io.Reader
	size   int
}

func (f fragmentReader) Read(p []byte) (int, error) {
	if len(p) > f.size {
		p = p[:f.size]
	}
	return f.source.Read(p)
}

func TestArbitrarilyFragmentedUTF8AndSSEFraming(t *testing.T) {
	for _, size := range []int{1, 2, 3, 7, 4096} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			wire := ": keepalive\r\n\r\n" + strings.ReplaceAll(created("response_1"), "\n", "\r\n") + "event: response.output_text.delta\r\ndata: {\r\ndata: \"type\":\"response.output_text.delta\",\"delta\":\"Привет 👾\"}\r\n\r\n" + terminal("response_1", "completed") + "data: [DONE]\n\n"
			got := consume(context.Background(), fragmentReader{source: strings.NewReader(wire), size: size})
			if got.State != inference.Completed || got.Text != "Привет 👾" || got.ResponseID != "response_1" {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestEmptyCompletedTextIsAValidReceipt(t *testing.T) {
	got := consume(context.Background(), strings.NewReader(created("r")+terminal("r", "completed")))
	if got.State != inference.Completed || got.Text != "" || got.Code != "" {
		t.Fatalf("%+v", got)
	}
}

func TestStreamFailureRegressionsNeverPublishPartial(t *testing.T) {
	partial := created("response_1") + delta("PRIVATE_PARTIAL")
	cases := map[string]string{
		"empty": "", "missing_terminal": partial,
		"delta_before_created":     delta("PRIVATE_PARTIAL"),
		"wrong_response_id":        partial + terminal("response_2", "completed"),
		"wrong_delta_id":           created("response_1") + event(map[string]any{"type": "response.output_text.delta", "response_id": "other", "delta": "PRIVATE_PARTIAL"}),
		"null_delta_id":            created("response_1") + `data: {"type":"response.output_text.delta","response_id":null,"delta":"PRIVATE_PARTIAL"}` + "\n\n",
		"wrong_status":             partial + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "response_1", "status": "failed"}}),
		"duplicate_created":        partial + created("response_1"),
		"duplicate_terminal":       partial + terminal("response_1", "completed") + terminal("response_1", "completed"),
		"data_after_terminal":      partial + terminal("response_1", "completed") + delta("late"),
		"done_without_receipt":     partial + "data: [DONE]\n\n",
		"duplicate_done_marker":    partial + terminal("response_1", "completed") + "data: [DONE]\n\ndata: [DONE]\n\n",
		"error_after_partial":      partial + event(map[string]any{"type": "error", "error": map[string]any{"code": "PRIVATE_ERROR", "message": "PRIVATE_MESSAGE"}}),
		"invalid_json":             partial + "data: {\n\n",
		"duplicate_json":           partial + `data: {"type":"response.completed","type":"response.failed","response":{"id":"response_1","status":"failed"}}` + "\n\n",
		"nested_duplicate_json":    partial + `data: {"type":"response.completed","response":{"id":"response_1","id":"response_2","status":"completed"}}` + "\n\n",
		"trailing_json":            partial + `data: {"type":"response.completed","response":{"id":"response_1","status":"completed"}} {}` + "\n\n",
		"invalid_utf8":             partial + "data: {\"type\":\"\xff\"}\n\n",
		"unpaired_surrogate":       partial + `data: {"type":"response.output_text.delta","delta":"\ud800"}` + "\n\n",
		"event_type_mismatch":      partial + "event: response.failed\n" + terminal("response_1", "completed"),
		"unterminated_terminal":    partial + strings.TrimSuffix(terminal("response_1", "completed"), "\n"),
		"unknown_event":            partial + event(map[string]any{"type": "response.tools.success"}),
		"text_done_mismatch":       partial + event(map[string]any{"type": "response.output_text.done", "text": "other"}),
		"delta_after_text_done":    partial + event(map[string]any{"type": "response.output_text.done", "text": "PRIVATE_PARTIAL"}) + delta("late"),
		"sequence_gap":             `data: {"type":"response.created","sequence_number":0,"response":{"id":"response_1","status":"in_progress"}}` + "\n\n" + `data: {"type":"response.completed","sequence_number":2,"response":{"id":"response_1","status":"completed"}}` + "\n\n",
		"sequence_dropped":         `data: {"type":"response.created","sequence_number":0,"response":{"id":"response_1","status":"in_progress"}}` + "\n\n" + terminal("response_1", "completed"),
		"sequence_nonzero_start":   `data: {"type":"response.created","sequence_number":1,"response":{"id":"response_1","status":"in_progress"}}` + "\n\n",
		"terminal_function_call":   partial + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "response_1", "status": "completed", "output": []any{map[string]any{"id": "tool_1", "type": "function_call", "name": "shell", "arguments": `{}`}}}}),
		"terminal_output_mismatch": partial + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "response_1", "status": "completed", "output": []any{map[string]any{"id": "message_1", "type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "other"}}}}}}),
	}
	for name, wire := range cases {
		t.Run(name, func(t *testing.T) {
			got := consume(context.Background(), strings.NewReader(wire))
			if got.State != inference.Unknown || got.Text != "" || got.Code == "" {
				t.Fatalf("bad stream accepted: %+v", got)
			}
			encoded, _ := json.Marshal(got)
			if strings.Contains(string(encoded), "PRIVATE") {
				t.Fatal("partial text or raw diagnostics escaped")
			}
		})
	}
}

func TestTerminalFailureAndIncompleteAreKnownWithoutPartialText(t *testing.T) {
	for _, status := range []string{"failed", "incomplete"} {
		t.Run(status, func(t *testing.T) {
			got := consume(context.Background(), strings.NewReader(created("r")+delta("PRIVATE_PARTIAL")+terminal("r", status)))
			if got.State != inference.Failed || got.ResponseID != "r" || got.Text != "" || got.Code == "" {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestEveryStreamCapacityIsBounded(t *testing.T) {
	cases := map[string]string{
		"frame":           created("r") + "data: " + strings.Repeat("x", MaxFrameBytes+1) + "\n\n",
		"multiline_frame": created("r") + strings.Repeat("data: "+strings.Repeat("x", 1024)+"\n", MaxFrameBytes/1024+1) + "\n",
		"events":          created("r") + strings.Repeat(event(map[string]any{"type": "response.in_progress", "response": map[string]any{"id": "r", "status": "in_progress"}}), MaxEvents),
		"text":            created("r") + delta(strings.Repeat("x", inference.MaxOutputBytes+1)),
		"bytes":           strings.Repeat(":"+strings.Repeat("x", 1022)+"\n", MaxStreamBytes/1024+1),
	}
	for name, wire := range cases {
		t.Run(name, func(t *testing.T) {
			got := consume(context.Background(), strings.NewReader(wire))
			if got.State != inference.Unknown || got.Code != StreamLimit || got.Text != "" {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestStrictJSONBoundary(t *testing.T) {
	for _, good := range []string{`{}`, `[]`, `{"type":"a","nested":{"type":"b"}}`, `{"text":"\ud83d\ude3e"}`, `{"text":"\\ud800"}`, `{"q":1,"Q":2}`} {
		if !validJSON([]byte(good)) {
			t.Fatalf("valid JSON rejected: %s", good)
		}
	}
	for _, bad := range []string{`{"a":1,"\u0061":2}`, `{"x":"\ud800"}`, `{"x":"\udfff"}`, `{"x":"\ud800\ud800"}`, `{} {}`, `{"x":"` + "\xff" + `"}`, strings.Repeat("[", maxJSONDepth+2) + "0" + strings.Repeat("]", maxJSONDepth+2)} {
		if validJSON([]byte(bad)) {
			t.Fatalf("ambiguous JSON accepted: %s", bad)
		}
	}
}

func TestExactCanonicalProtocolKeysRejectGoJSONAliases(t *testing.T) {
	prefix := created("r") + delta("summary")
	cases := map[string]string{
		"event_alias_collision":          `{"type":"error","Type":"response.completed","response":{"id":"r","status":"completed"}}`,
		"event_alias_only":               `{"Type":"response.completed","response":{"id":"r","status":"completed"}}`,
		"response_id_alias":              `{"type":"response.completed","response":{"id":"foreign","ID":"r","status":"completed"}}`,
		"response_status_alias":          `{"type":"response.completed","response":{"id":"r","status":"failed","Status":"completed"}}`,
		"unicode_status_alias_collision": `{"type":"response.completed","response":{"id":"r","status":"failed","ſtatus":"completed"}}`,
		"unicode_status_alias_only":      `{"type":"response.completed","response":{"id":"r","ſtatus":"completed"}}`,
		"item_type_alias":                `{"type":"response.completed","response":{"id":"r","status":"completed","output":[{"id":"m","type":"function_call","Type":"message","role":"assistant","content":[{"type":"output_text","text":"summary"}]}]}}`,
		"item_id_alias":                  `{"type":"response.completed","response":{"id":"r","status":"completed","output":[{"id":"foreign","ID":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"summary"}]}]}}`,
		"item_status_alias":              `{"type":"response.completed","response":{"id":"r","status":"completed","output":[{"id":"m","type":"message","role":"assistant","status":"incomplete","Status":"completed","content":[{"type":"output_text","text":"summary"}]}]}}`,
		"content_text_alias":             `{"type":"response.completed","response":{"id":"r","status":"completed","output":[{"id":"m","type":"message","role":"assistant","content":[{"type":"output_text","text":"foreign","Text":"summary"}]}]}}`,
		"escaped_event_alias":            `{"type":"error","\u0054ype":"response.completed","response":{"id":"r","status":"completed"}}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			got := consume(context.Background(), strings.NewReader(prefix+"data: "+raw+"\n\n"))
			if got.State != inference.Unknown || got.Code != StreamInvalid || got.Text != "" {
				t.Fatalf("protocol alias accepted: %+v", got)
			}
		})
	}
	// Unicode folding matches Go's decoder, including non-ASCII simple-fold cycles.
	if foldJSONKey("status") != foldJSONKey("ſtatus") || foldJSONKey("key") != foldJSONKey("Key") {
		t.Fatal("Unicode simple folding mismatch")
	}
}

func TestCompletedFinalItemsRequireCompletedStatusWhenSupplied(t *testing.T) {
	for _, status := range []string{"incomplete", "in_progress", "", "completed", "omitted", "null"} {
		t.Run(status, func(t *testing.T) {
			item := messageItem("m", "summary")
			if status == "omitted" {
				delete(item, "status")
			} else if status == "null" {
				item["status"] = nil
			} else {
				item["status"] = status
			}
			wire := created("r") + delta("summary") + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{item}}})
			got := consume(context.Background(), strings.NewReader(wire))
			if status == "completed" || status == "omitted" {
				if got.State != inference.Completed || got.Text != "summary" {
					t.Fatalf("valid status refused: %+v", got)
				}
			} else if got.State != inference.Unknown || got.Text != "" {
				t.Fatalf("nonterminal final item accepted: %+v", got)
			}
		})
	}
}

func itemEvent(kind, id string, index int, item map[string]any) string {
	return event(map[string]any{"type": kind, "response_id": "r", "output_index": index, "item_id": id, "item": item})
}
func textEvent(kind, id string, output, content int, field, value string) string {
	return event(map[string]any{"type": kind, "response_id": "r", "output_index": output, "content_index": content, "item_id": id, field: value})
}
func messageItem(id, text string) map[string]any {
	return map[string]any{"id": id, "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": text}}}
}

func TestOutputItemCorrelationAndFinalText(t *testing.T) {
	added := map[string]any{"id": "message_1", "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}
	wire := created("r") + itemEvent("response.output_item.added", "message_1", 0, added)
	wire += event(map[string]any{"type": "response.content_part.added", "response_id": "r", "item_id": "message_1", "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": ""}})
	wire += textEvent("response.output_text.delta", "message_1", 0, 0, "delta", "selected summary")
	wire += textEvent("response.output_text.done", "message_1", 0, 0, "text", "selected summary")
	wire += event(map[string]any{"type": "response.content_part.done", "response_id": "r", "item_id": "message_1", "output_index": 0, "content_index": 0, "part": map[string]any{"type": "output_text", "text": "selected summary"}})
	wire += itemEvent("response.output_item.done", "message_1", 0, messageItem("message_1", "selected summary"))
	wire += event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{messageItem("message_1", "selected summary")}}})
	got := consume(context.Background(), strings.NewReader(wire))
	if got.State != inference.Completed || got.Text != "selected summary" {
		t.Fatalf("%+v", got)
	}
	for name, broken := range map[string]string{
		"foreign_item":                    created("r") + itemEvent("response.output_item.added", "message_1", 0, added) + textEvent("response.output_text.delta", "other", 0, 0, "delta", "secret"),
		"unknown_item":                    created("r") + textEvent("response.output_text.delta", "message_1", 0, 0, "delta", "secret"),
		"foreign_index":                   created("r") + itemEvent("response.output_item.added", "message_1", 0, added) + textEvent("response.output_text.delta", "message_1", 1, 0, "delta", "secret"),
		"missing_item_field":              created("r") + event(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "secret"}),
		"duplicate_item":                  created("r") + itemEvent("response.output_item.added", "message_1", 0, added) + itemEvent("response.output_item.added", "message_1", 1, added),
		"tool_added":                      created("r") + itemEvent("response.output_item.added", "tool_1", 0, map[string]any{"id": "tool_1", "type": "function_call"}),
		"done_wrong_text":                 created("r") + itemEvent("response.output_item.added", "message_1", 0, added) + textEvent("response.output_text.delta", "message_1", 0, 0, "delta", "secret") + itemEvent("response.output_item.done", "message_1", 0, messageItem("message_1", "wrong")),
		"missing_final_output_after_item": created("r") + itemEvent("response.output_item.added", "message_1", 0, added) + terminal("r", "completed"),
		"reasoning_as_visible_text":       created("r") + delta("secret") + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{map[string]any{"id": "reasoning_1", "type": "reasoning", "content": []any{map[string]any{"type": "output_text", "text": "secret"}}}}}}),
	} {
		t.Run(name, func(t *testing.T) {
			got := consume(context.Background(), strings.NewReader(broken))
			if got.State != inference.Unknown || got.Text != "" {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestCorrelatedSequencesAndRefusal(t *testing.T) {
	wire := `data: {"type":"response.created","sequence_number":0,"response":{"id":"r","status":"in_progress"}}` + "\n\n" + `data: {"type":"response.completed","sequence_number":1,"response":{"id":"r","status":"completed","output":[]}}` + "\n\n"
	if got := consume(context.Background(), strings.NewReader(wire)); got.State != inference.Completed {
		t.Fatalf("%+v", got)
	}
	wire = created("r") + event(map[string]any{"type": "response.refusal.delta", "delta": "PRIVATE_REASON"}) + terminal("r", "completed")
	if got := consume(context.Background(), strings.NewReader(wire)); got.State != inference.Failed || got.Code != ProviderRefused || got.Text != "" {
		t.Fatalf("%+v", got)
	}
}

type faultReader struct{ prefix *strings.Reader }

func (r faultReader) Read(p []byte) (int, error) {
	if r.prefix.Len() != 0 {
		return r.prefix.Read(p)
	}
	return 0, fmt.Errorf("PRIVATE_IO_DIAGNOSTIC")
}
func TestStreamReadFailureIsUnknown(t *testing.T) {
	got := consume(context.Background(), faultReader{prefix: strings.NewReader(created("r") + delta("PRIVATE_PARTIAL"))})
	if got.State != inference.Unknown || got.Code != TransportUnknown || got.Text != "" {
		t.Fatalf("%+v", got)
	}
}

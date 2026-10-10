package planresponses

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

// These properties exercise bounded synthetic streams, not provider effects.
// A short fuzz run is useful mutation evidence, not exhaustive protocol proof.
func FuzzStreamFragmentationAndFailClosedMutations(f *testing.F) {
	for _, seed := range []struct {
		raw        string
		size, mode uint8
	}{
		{"", 0, 0},
		{created("r") + delta("é猫🐈") + terminal("r", "completed"), 0, 0},
		{": keepalive\r\n\r\n" + created("r") + terminal("r", "completed"), 7, 0},
		{"data: {\"type\":\"\xff\"}\n\n", 1, 0},
		{created("r") + delta("partial"), 3, 0},
	} {
		f.Add([]byte(seed.raw), seed.size, seed.mode)
	}
	for mode := uint8(1); mode < 24; mode++ {
		f.Add([]byte("é猫🐈\nselected text"), mode, mode)
	}
	f.Fuzz(func(t *testing.T, data []byte, fragment, mode uint8) {
		if len(data) > 64<<10 {
			t.Skip()
		}
		wire, wantCompletion := mutationWire(data, mode%24)
		baseline := consume(context.Background(), bytes.NewReader(wire))
		fragmented := consume(context.Background(), fragmentReader{source: bytes.NewReader(wire), size: 1 + int(fragment%32)})
		if baseline != fragmented {
			t.Fatalf("fragmentation changed the classified outcome: baseline=%+v fragmented=%+v", baseline, fragmented)
		}
		if baseline.State != inference.Completed && baseline.Text != "" {
			t.Fatalf("non-completed stream disclosed text: %+v", baseline)
		}
		if baseline.State == inference.Completed && (baseline.Code != "" || !identifier(baseline.ResponseID) || !utf8.ValidString(baseline.Text) || len(baseline.Text) > inference.MaxOutputBytes) {
			t.Fatalf("unbounded or malformed completion: %+v", baseline)
		}
		if mode%24 == 0 {
			return
		} // Arbitrary bytes may represent a valid receipt.
		if wantCompletion {
			if baseline.State != inference.Completed || baseline.Text != strings.ToValidUTF8(string(data), "\ufffd") {
				t.Fatalf("valid generated stream refused: %+v", baseline)
			}
		} else if baseline.State == inference.Completed || baseline.Text != "" || baseline.Code == "" {
			t.Fatalf("mutated stream did not fail closed: %+v", baseline)
		}
	})
}

func mutationWire(data []byte, mode uint8) ([]byte, bool) {
	if mode == 0 {
		return data, false
	}
	text := strings.ToValidUTF8(string(data), "\ufffd")
	prefix := created("r") + delta(text)
	valid := prefix + terminal("r", "completed")
	var wire string
	switch mode {
	case 1:
		return []byte(valid), true
	case 2:
		wire = prefix // EOF without a terminal receipt.
	case 3:
		wire = prefix + terminal("foreign", "completed")
	case 4:
		wire = prefix + event(map[string]any{"type": "error", "message": "PRIVATE_DIAGNOSTIC"})
	case 5:
		wire = prefix + "data: {\n\n"
	case 6:
		wire = prefix + `data: {"type":"error","type":"response.completed","response":{"id":"r","status":"completed"}}` + "\n\n"
	case 7:
		wire = prefix + `data: {"type":"error","Type":"response.completed","response":{"id":"r","status":"completed"}}` + "\n\n"
	case 8:
		wire = prefix + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "failed"}})
	case 9:
		wire = prefix + created("r") + terminal("r", "completed")
	case 10:
		wire = delta(text) + created("r") + terminal("r", "completed")
	case 11:
		wire = valid + terminal("r", "completed")
	case 12:
		wire = valid + delta("late")
	case 13:
		wire = prefix + "data: {\"type\":\"response.output_text.delta\",\"delta\":\"\xff\"}\n\n" + terminal("r", "completed")
	case 14:
		wire = strings.TrimSuffix(valid, "\n")
	case 15:
		wire = prefix + "data: [DONE]\n\n"
	case 16:
		wire = `data: {"type":"response.created","sequence_number":0,"response":{"id":"r","status":"in_progress"}}` + "\n\n" + `data: {"type":"response.completed","sequence_number":2,"response":{"id":"r","status":"completed"}}` + "\n\n"
	case 17:
		wire = prefix + event(map[string]any{"type": "response.output_text.delta", "item_id": "foreign", "output_index": 0, "content_index": 0, "delta": "late"})
	case 18:
		wire = prefix + `data: {"type":"response.completed","response":{"id":"r","ſtatus":"completed"}}` + "\n\n"
	case 19:
		item := messageItem("m", text)
		item["status"] = "incomplete"
		wire = prefix + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{item}}})
	case 20:
		wire = prefix + event(map[string]any{"type": "response.output_text.done", "text": text + "foreign"})
	case 21:
		wire = prefix + terminal("r", "failed") // Known remote failure still suppresses partial text.
	case 22:
		wire = prefix + terminal("r", "incomplete")
	case 23:
		wire = prefix + event(map[string]any{"type": "response.completed", "response": map[string]any{"id": "r", "status": "completed", "output": []any{map[string]any{"id": "tool", "type": "function_call", "call_id": "call_1", "name": "shell", "arguments": `{}`}}}})
	}
	return []byte(wire), false
}

func TestEveryTruncationBeforeTerminalReceiptFailsClosed(t *testing.T) {
	wire := []byte(created("r") + delta("é猫🐈") + terminal("r", "completed"))
	for cut := 0; cut < len(wire); cut++ {
		got := consume(context.Background(), fragmentReader{source: bytes.NewReader(wire[:cut]), size: 1})
		if got.State == inference.Completed || got.Text != "" || got.Code == "" {
			t.Fatalf("truncation %d accepted: %+v", cut, got)
		}
	}
}

func TestRequestItemAndEncodedByteCapBoundaries(t *testing.T) {
	r := fixtureRequest()
	r.Input = make([]inference.InputItem, inference.MaxInputItems)
	for i := range r.Input {
		r.Input[i] = inference.InputItem{Kind: "message", Role: "user"}
	}
	if _, ok := requestBody(r); !ok {
		t.Fatal("maximum admitted item count refused")
	}
	r.Input = append(r.Input, inference.InputItem{Kind: "message", Role: "user"})
	if _, ok := requestBody(r); ok {
		t.Fatal("item cap exceeded")
	}
	// ASCII content makes each additional input byte increase both encoded
	// representations by one. Find the actual effective boundary, rather than
	// treating raw content length as the complete request size.
	r = fixtureRequest()
	low, high := 0, inference.MaxInputBytes+1
	for low+1 < high {
		middle := low + (high-low)/2
		r.Input[0].Content = strings.Repeat("x", middle)
		if _, ok := requestBody(r); ok {
			low = middle
		} else {
			high = middle
		}
	}
	r.Input[0].Content = strings.Repeat("x", low)
	body, ok := requestBody(r)
	canonical, err := json.Marshal(r.Input)
	if !ok || err != nil || len(body) != inference.MaxInputBytes && len(canonical) != inference.MaxInputBytes {
		t.Fatalf("effective encoded boundary missing: body=%d canonical=%d accepted=%v", len(body), len(canonical), ok)
	}
	r.Input[0].Content += "x"
	if _, ok := requestBody(r); ok {
		t.Fatal("one byte above effective cap admitted")
	}
}

func TestStreamExactCapacityBoundaries(t *testing.T) {
	t.Run("text", func(t *testing.T) {
		text := strings.Repeat("x", inference.MaxOutputBytes)
		got := consume(context.Background(), strings.NewReader(created("r")+delta(text)+terminal("r", "completed")))
		if got.State != inference.Completed || got.Text != text {
			t.Fatalf("exact text cap refused: %+v", got)
		}
	})
	t.Run("events", func(t *testing.T) {
		progress := event(map[string]any{"type": "response.in_progress", "response": map[string]any{"id": "r", "status": "in_progress"}})
		wire := created("r") + strings.Repeat(progress, MaxEvents-2) + terminal("r", "completed")
		got := consume(context.Background(), strings.NewReader(wire))
		if got.State != inference.Completed {
			t.Fatalf("exact event cap refused: %+v", got)
		}
	})
	t.Run("line", func(t *testing.T) {
		base := `data: {"type":"response.output_text.delta","delta":"","opaque_metadata":"` + `"}` + "\n"
		line := `data: {"type":"response.output_text.delta","delta":"","opaque_metadata":"` + strings.Repeat("x", MaxFrameBytes-len(base)) + `"}` + "\n"
		if len(line) != MaxFrameBytes {
			t.Fatal("fixture does not reach exact line cap")
		}
		got := consume(context.Background(), strings.NewReader(created("r")+line+"\n"+terminal("r", "completed")))
		if got.State != inference.Completed {
			t.Fatalf("exact line cap refused: %+v", got)
		}
		tooLarge := strings.Replace(line, `opaque_metadata":"`, `opaque_metadata":"x`, 1)
		got = consume(context.Background(), strings.NewReader(created("r")+tooLarge+"\n"+terminal("r", "completed")))
		if got.State != inference.Unknown || got.Code != StreamLimit || got.Text != "" {
			t.Fatalf("line above cap admitted: %+v", got)
		}
	})
}

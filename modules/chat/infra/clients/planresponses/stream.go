package planresponses

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

const (
	MaxFrameBytes  = 512 << 10
	MaxStreamBytes = 4 << 20
	MaxEvents      = 4096
	maxOutputItems = 128
)

type providerError struct {
	Code  string `json:"code"`
	Param string `json:"param"`
}
type contentPart struct {
	Type string  `json:"type"`
	Text *string `json:"text"`
}
type outputItem struct {
	ID      string        `json:"id"`
	Type    string        `json:"type"`
	Role    string        `json:"role"`
	Status  *string       `json:"status"`
	Content []contentPart `json:"content"`
}
type responseValue struct {
	ID     string          `json:"id"`
	Status string          `json:"status"`
	Error  *providerError  `json:"error"`
	Output json.RawMessage `json:"output"`
}
type wireEvent struct {
	Type         string         `json:"type"`
	Sequence     *int64         `json:"sequence_number"`
	ResponseID   *string        `json:"response_id"`
	Response     *responseValue `json:"response"`
	ItemID       *string        `json:"item_id"`
	OutputIndex  *int           `json:"output_index"`
	ContentIndex *int           `json:"content_index"`
	Item         *outputItem    `json:"item"`
	Part         *contentPart   `json:"part"`
	Delta        *string        `json:"delta"`
	Text         *string        `json:"text"`
	Code         string         `json:"code"`
	Param        string         `json:"param"`
	Error        *providerError `json:"error"`
}
type trackedItem struct {
	item outputItem
	done bool
}
type partKey struct{ output, content int }
type trackedPart struct {
	text        strings.Builder
	done        bool
	added       bool
	contentDone bool
}
type streamState struct {
	id         string
	text       strings.Builder
	items      map[int]*trackedItem
	parts      map[partKey]*trackedPart
	sequence   int64
	sequenced  bool
	started    bool
	terminal   bool
	doneMarker bool
	refused    bool
	textDone   bool
	out        inference.Outcome
}

func consume(ctx context.Context, source io.Reader) inference.Outcome {
	state := streamState{items: make(map[int]*trackedItem), parts: make(map[partKey]*trackedPart)}
	reader := bufio.NewReaderSize(io.LimitReader(source, MaxStreamBytes+1), 4096)
	var frame bytes.Buffer
	var eventName string
	bytesRead, events := 0, 0
	for {
		if ctx.Err() != nil {
			return uncertain(inference.Cancelled, state.id)
		}
		var line []byte
		for {
			piece, err := reader.ReadSlice('\n')
			bytesRead += len(piece)
			if bytesRead > MaxStreamBytes || len(line)+len(piece) > MaxFrameBytes {
				return uncertain(StreamLimit, state.id)
			}
			line = append(line, piece...)
			if err == bufio.ErrBufferFull {
				continue
			}
			if err != nil {
				if ctx.Err() != nil {
					return uncertain(inference.Cancelled, state.id)
				}
				if err != io.EOF {
					return uncertain(TransportUnknown, state.id)
				}
				// A frame needs its terminating blank line. EOF never dispatches it.
				if !utf8.Valid(line) {
					return uncertain(StreamInvalid, state.id)
				}
				if len(frame.Bytes()) != 0 || eventName != "" || len(line) != 0 && !bytes.HasPrefix(line, []byte(":")) {
					return uncertain(StreamIncomplete, state.id)
				}
				if !state.terminal {
					return uncertain(StreamIncomplete, state.id)
				}
				if state.out.State == inference.Completed {
					state.out.Text = state.text.String()
				}
				return state.out
			}
			break
		}
		line = bytes.TrimSuffix(bytes.TrimSuffix(line, []byte{'\n'}), []byte{'\r'})
		if !utf8.Valid(line) {
			return uncertain(StreamInvalid, state.id)
		}
		if len(line) == 0 {
			if frame.Len() != 0 {
				events++
				if events > MaxEvents {
					return uncertain(StreamLimit, state.id)
				}
				code := state.accept(bytes.TrimSuffix(frame.Bytes(), []byte{'\n'}), eventName)
				if code != "" {
					return uncertain(code, state.id)
				}
			}
			frame.Reset()
			eventName = ""
			continue
		}
		if line[0] == ':' {
			continue
		}
		name, value, _ := bytes.Cut(line, []byte{':'})
		value = bytes.TrimPrefix(value, []byte{' '})
		switch string(name) {
		case "data":
			if frame.Len()+len(value)+1 > MaxFrameBytes {
				return uncertain(StreamLimit, state.id)
			}
			frame.Write(value)
			frame.WriteByte('\n')
		case "event":
			if eventName != "" || len(value) > 128 {
				return uncertain(StreamInvalid, state.id)
			}
			eventName = string(value)
		case "id", "retry": // SSE delivery metadata grants no inference authority.
		default:
			return uncertain(StreamInvalid, state.id)
		}
	}
}

func (s *streamState) accept(raw []byte, eventName string) inference.Code {
	if bytes.Equal(raw, []byte("[DONE]")) {
		if !s.terminal || s.doneMarker || eventName != "" {
			return StreamInvalid
		}
		s.doneMarker = true
		return ""
	}
	if s.terminal || !validJSON(raw) || !validProtocolEvent(raw) {
		return StreamInvalid
	}
	var event wireEvent
	if json.Unmarshal(raw, &event) != nil || event.Type == "" || eventName != "" && eventName != event.Type {
		return StreamInvalid
	}
	// Null is not a supplied optional correlation value.
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return StreamInvalid
	}
	for _, field := range []string{"sequence_number", "response_id", "response", "item_id", "output_index", "content_index", "item", "part", "delta", "text"} {
		if value, exists := object[field]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return StreamInvalid
		}
	}
	if !s.started {
		if event.Sequence != nil {
			if *event.Sequence != 0 {
				return StreamInvalid
			}
			s.sequenced = true
		}
	} else if s.sequenced != (event.Sequence != nil) {
		return StreamInvalid
	}
	if event.Sequence != nil {
		if *event.Sequence < 0 || s.started && *event.Sequence != s.sequence+1 {
			return StreamInvalid
		}
		s.sequence = *event.Sequence
	}
	if event.ResponseID != nil && (s.id == "" || *event.ResponseID != s.id) {
		return StreamInvalid
	}
	if event.Response != nil && s.id != "" && event.Response.ID != s.id {
		return StreamInvalid
	}
	if event.Type != "response.created" && event.Type != "error" && s.id == "" {
		return StreamInvalid
	}
	s.started = true
	switch event.Type {
	case "response.created":
		if s.id != "" || event.Response == nil || !identifier(event.Response.ID) || event.Response.Status != "in_progress" || event.Response.Error != nil {
			return StreamInvalid
		}
		s.id = event.Response.ID
	case "response.in_progress":
		if event.Response == nil || event.Response.Status != "in_progress" || event.Response.Error != nil {
			return StreamInvalid
		}
	case "response.output_item.added", "response.output_item.done":
		if event.OutputIndex == nil || *event.OutputIndex < 0 || *event.OutputIndex >= maxOutputItems || event.Item == nil || !validItem(*event.Item) {
			return StreamInvalid
		}
		index := *event.OutputIndex
		if event.ItemID != nil && *event.ItemID != event.Item.ID {
			return StreamInvalid
		}
		if event.Type == "response.output_item.added" {
			if s.items[index] != nil {
				return StreamInvalid
			}
			for _, prior := range s.items {
				if prior.item.ID == event.Item.ID {
					return StreamInvalid
				}
			}
			s.items[index] = &trackedItem{item: *event.Item}
		} else {
			prior := s.items[index]
			if prior == nil || prior.done || prior.item.ID != event.Item.ID || prior.item.Type != event.Item.Type || !s.checkItemText(index, *event.Item) {
				return StreamInvalid
			}
			prior.done = true
			prior.item = *event.Item
		}
	case "response.output_text.delta", "response.output_text.done":
		part, code := s.part(event, true)
		if code != "" {
			return code
		}
		if part != nil && part.done || part == nil && s.textDone {
			return StreamInvalid
		}
		if event.Type == "response.output_text.delta" {
			if event.Delta == nil {
				return StreamInvalid
			}
			if s.text.Len()+len(*event.Delta) > inference.MaxOutputBytes {
				return StreamLimit
			}
			s.text.WriteString(*event.Delta)
			if part != nil {
				part.text.WriteString(*event.Delta)
			}
		} else {
			if event.Text == nil {
				return StreamInvalid
			}
			want := s.text.String()
			if part != nil {
				want = part.text.String()
			}
			if *event.Text != want {
				return StreamInvalid
			}
			if part != nil {
				part.done = true
			} else {
				s.textDone = true
			}
		}
	case "response.content_part.added", "response.content_part.done":
		part, code := s.part(event, true)
		if code != "" || part == nil || event.Part == nil || event.Part.Type != "output_text" && event.Part.Type != "refusal" {
			return StreamInvalid
		}
		if event.Part.Type == "refusal" {
			s.refused = true
			return ""
		}
		if event.Type == "response.content_part.added" {
			if part.added || part.done || part.text.Len() != 0 {
				return StreamInvalid
			}
			part.added = true
		} else {
			if !part.added || part.contentDone {
				return StreamInvalid
			}
			part.contentDone = true
		}
		if event.Part.Text == nil || event.Type == "response.content_part.added" && *event.Part.Text != "" || event.Type == "response.content_part.done" && *event.Part.Text != part.text.String() {
			return StreamInvalid
		}
	case "response.refusal.delta", "response.refusal.done":
		if _, code := s.part(event, true); code != "" {
			return code
		}
		s.refused = true
	case "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.reasoning_text.delta", "response.reasoning_text.done":
		if _, code := s.part(event, false); code != "" {
			return code
		}
	case "response.completed", "response.failed", "response.incomplete":
		if event.Response == nil || event.Response.ID != s.id || event.Response.Status != strings.TrimPrefix(event.Type, "response.") {
			return StreamInvalid
		}
		if !s.checkOutput(event.Response.Output, event.Type == "response.completed") {
			return StreamInvalid
		}
		s.terminal = true
		s.out = inference.Outcome{State: inference.Failed, ResponseID: s.id, Code: ProviderFailed}
		switch event.Type {
		case "response.completed":
			if event.Response.Error != nil {
				return StreamInvalid
			}
			if s.refused {
				s.out.Code = ProviderRefused
			} else {
				s.out.State = inference.Completed
				s.out.Code = ""
			}
		case "response.incomplete":
			s.out.Code = StreamIncomplete
		case "response.failed":
			if event.Response.Error != nil {
				s.out.Code = safeFailure(event.Response.Error.Code, event.Response.Error.Param, ProviderFailed)
			}
		}
	case "error":
		// An uncorrelated error is not a terminal response receipt.
		return ProviderFailed
	default:
		return StreamInvalid
	}
	return ""
}

func validItem(item outputItem) bool {
	if !identifier(item.ID) || item.Type != "message" && item.Type != "reasoning" {
		return false
	}
	if item.Type == "message" && item.Role != "assistant" {
		return false
	}
	if item.Type == "reasoning" && len(item.Content) != 0 {
		return false
	}
	if item.Status != nil && *item.Status != "in_progress" && *item.Status != "completed" && *item.Status != "incomplete" {
		return false
	}
	if len(item.Content) > maxOutputItems {
		return false
	}
	for _, part := range item.Content {
		if part.Type != "output_text" && part.Type != "refusal" || part.Type == "output_text" && part.Text == nil {
			return false
		}
	}
	return true
}

func (s *streamState) part(event wireEvent, text bool) (*trackedPart, inference.Code) {
	if event.ItemID == nil && event.OutputIndex == nil && event.ContentIndex == nil {
		return nil, ""
	}
	if event.ItemID == nil || event.OutputIndex == nil || text && event.ContentIndex == nil || *event.OutputIndex < 0 || *event.OutputIndex >= maxOutputItems {
		return nil, StreamInvalid
	}
	item := s.items[*event.OutputIndex]
	if item == nil || item.done || item.item.ID != *event.ItemID || text && item.item.Type != "message" || !text && item.item.Type != "reasoning" {
		return nil, StreamInvalid
	}
	if !text {
		return nil, ""
	}
	if *event.ContentIndex < 0 || *event.ContentIndex >= maxOutputItems {
		return nil, StreamInvalid
	}
	key := partKey{*event.OutputIndex, *event.ContentIndex}
	if s.parts[key] == nil {
		s.parts[key] = &trackedPart{}
	}
	return s.parts[key], ""
}

func (s *streamState) checkItemText(index int, item outputItem) bool {
	if item.Type == "reasoning" {
		return true
	}
	for i, content := range item.Content {
		if content.Type == "refusal" {
			s.refused = true
			continue
		}
		part := s.parts[partKey{index, i}]
		if part == nil {
			if *content.Text != "" {
				return false
			}
		} else if *content.Text != part.text.String() {
			return false
		}
	}
	for key, part := range s.parts {
		if key.output == index && key.content >= len(item.Content) && part.text.Len() != 0 {
			return false
		}
	}
	return true
}

func (s *streamState) checkOutput(raw json.RawMessage, completed bool) bool {
	if len(raw) == 0 {
		return len(s.items) == 0
	}
	var output []outputItem
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &output) != nil || len(output) > maxOutputItems {
		return false
	}
	var final strings.Builder
	seen := make(map[string]bool)
	for i, item := range output {
		if !validItem(item) || seen[item.ID] {
			return false
		}
		if completed && item.Status != nil && *item.Status != "completed" {
			return false
		}
		seen[item.ID] = true
		if prior := s.items[i]; prior != nil && (prior.item.ID != item.ID || prior.item.Type != item.Type) {
			return false
		}
		if len(s.items) != 0 && !s.checkItemText(i, item) {
			return false
		}
		for _, content := range item.Content {
			if content.Type == "refusal" {
				s.refused = true
				continue
			}
			if final.Len()+len(*content.Text) > inference.MaxOutputBytes {
				return false
			}
			final.WriteString(*content.Text)
		}
	}
	for index := range s.items {
		if index >= len(output) {
			return false
		}
	}
	return final.String() == s.text.String()
}

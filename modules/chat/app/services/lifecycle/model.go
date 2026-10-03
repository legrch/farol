package lifecycle

import (
	"encoding/json"

	"github.com/legrch/farol/modules/chat/domain/output"
	"github.com/legrch/farol/modules/chat/domain/stream"
)

// These are incremental text events on the existing Responses route. The
// selected Codex tool/compaction contract is intentionally not advertised here.
func appendModelFrame(buffer *stream.Buffer, name string, kind stream.Kind, fields map[string]any) error {
	fields["type"], fields["sequence_number"] = name, buffer.Snapshot().LastSequence+1
	bytes, err := json.Marshal(fields)
	if err != nil {
		return Invalid
	}
	_, err = buffer.Append(kind, bytes)
	return err
}
func responseValue(h *Handle, state output.State, status string) map[string]any {
	items := []any{}
	if state.ReplyID != "" {
		itemStatus := status
		if status == "failed" {
			itemStatus = "incomplete"
		}
		items = append(items, messageValue(state, itemStatus))
	}
	return map[string]any{"id": "resp-" + h.fixed.OperationID, "object": "response", "model": h.target.Selection.Alias, "status": status, "output": items}
}
func textPart(text string) map[string]any {
	return map[string]any{"type": "output_text", "text": text, "annotations": []any{}}
}
func messageValue(state output.State, status string) map[string]any {
	content := []any{}
	if state.Text() != "" {
		content = append(content, textPart(state.Text()))
	}
	return map[string]any{"id": state.ReplyID, "type": "message", "role": "assistant", "status": status, "content": content}
}
func createdFrames(h *Handle, candidate *stream.Buffer) error {
	return appendModelFrame(candidate, "response.created", stream.Phase, map[string]any{"response": responseValue(h, h.output, "in_progress")})
}
func deltaFrames(h *Handle, state output.State, delta string, candidate *stream.Buffer) error {
	fields := func() map[string]any {
		return map[string]any{"item_id": state.ReplyID, "output_index": 0, "content_index": 0}
	}
	if h.output.ReplyID == "" {
		item := messageValue(state, "in_progress")
		item["content"] = []any{}
		if err := appendModelFrame(candidate, "response.output_item.added", stream.Phase, map[string]any{"output_index": 0, "item": item}); err != nil {
			return err
		}
		f := fields()
		f["part"] = textPart("")
		if err := appendModelFrame(candidate, "response.content_part.added", stream.Phase, f); err != nil {
			return err
		}
	}
	f := fields()
	f["delta"] = delta
	return appendModelFrame(candidate, "response.output_text.delta", stream.Delta, f)
}
func completeFrames(h *Handle, state output.State, candidate *stream.Buffer) error {
	fields := func() map[string]any {
		return map[string]any{"item_id": state.ReplyID, "output_index": 0, "content_index": 0}
	}
	f := fields()
	f["text"] = state.Text()
	if err := appendModelFrame(candidate, "response.output_text.done", stream.Phase, f); err != nil {
		return err
	}
	f = fields()
	f["part"] = textPart(state.Text())
	if err := appendModelFrame(candidate, "response.content_part.done", stream.Phase, f); err != nil {
		return err
	}
	if err := appendModelFrame(candidate, "response.output_item.done", stream.Phase, map[string]any{"output_index": 0, "item": messageValue(state, "completed")}); err != nil {
		return err
	}
	return appendModelFrame(candidate, "response.completed", stream.Terminal, map[string]any{"response": responseValue(h, state, "completed")})
}
func failureFrames(h *Handle, code string, candidate *stream.Buffer) error {
	response := responseValue(h, h.output, "failed")
	response["error"] = map[string]any{"code": code, "message": code}
	return appendModelFrame(candidate, "response.failed", stream.Terminal, map[string]any{"response": response})
}

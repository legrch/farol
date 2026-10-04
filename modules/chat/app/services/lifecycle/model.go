package lifecycle

import (
	"encoding/json"

	"github.com/legrch/farol/modules/chat/domain/output"
	"github.com/legrch/farol/modules/chat/domain/stream"
)

// Incremental text and one explicitly selected external caller-tool round use
// the existing Responses route. No provider usage or tool execution is inferred.
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
		if h.caller == nil || !h.caller.roundOpened || len(state.Text()) > h.caller.textOffset {
			items = append(items, modelMessageValue(h, state, itemStatus))
		}
	}
	id, model := "resp-"+h.fixed.OperationID, h.target.Selection.Alias
	if h.caller != nil {
		model = h.caller.request.Scope.Model
		if h.caller.roundOpened {
			id += "-1"
		}
	}
	return map[string]any{"id": id, "object": "response", "model": model, "status": status, "output": items}
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
	if h.caller != nil && h.caller.phase != callerReturned {
		return Unsettled
	}
	fields := func() map[string]any {
		return map[string]any{"item_id": modelMessageID(h, state), "output_index": 0, "content_index": 0}
	}
	if h.output.ReplyID == "" || (h.caller != nil && h.caller.roundOpened && len(h.output.Text()) == h.caller.textOffset) {
		item := modelMessageValue(h, state, "in_progress")
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
	if h.caller != nil && (h.caller.phase != callerReturned || len(state.Text()) <= h.caller.textOffset) {
		return Unsettled
	}
	if err := completeTextFrames(h, state, candidate); err != nil {
		return err
	}
	return appendModelFrame(candidate, "response.completed", stream.Terminal, map[string]any{"response": responseValue(h, state, "completed")})
}
func completeTextFrames(h *Handle, state output.State, candidate *stream.Buffer) error {
	fields := func() map[string]any {
		return map[string]any{"item_id": modelMessageID(h, state), "output_index": 0, "content_index": 0}
	}
	f := fields()
	f["text"] = modelText(h, state)
	if err := appendModelFrame(candidate, "response.output_text.done", stream.Phase, f); err != nil {
		return err
	}
	f = fields()
	f["part"] = textPart(modelText(h, state))
	if err := appendModelFrame(candidate, "response.content_part.done", stream.Phase, f); err != nil {
		return err
	}
	if err := appendModelFrame(candidate, "response.output_item.done", stream.Phase, map[string]any{"output_index": 0, "item": modelMessageValue(h, state, "completed")}); err != nil {
		return err
	}
	return nil
}
func failureFrames(h *Handle, code string, candidate *stream.Buffer) error {
	response := responseValue(h, h.output, "failed")
	response["error"] = map[string]any{"code": code, "message": code}
	return appendModelFrame(candidate, "response.failed", stream.Terminal, map[string]any{"response": response})
}

func modelMessageID(h *Handle, state output.State) string {
	if h.caller != nil && h.caller.roundOpened {
		return state.ReplyID + "-round-1"
	}
	return state.ReplyID
}
func modelText(h *Handle, state output.State) string {
	if h.caller != nil && h.caller.roundOpened {
		return state.Text()[h.caller.textOffset:]
	}
	return state.Text()
}
func modelMessageValue(h *Handle, state output.State, status string) map[string]any {
	item := messageValue(state, status)
	item["id"] = modelMessageID(h, state)
	content := []any{}
	if text := modelText(h, state); text != "" {
		content = append(content, textPart(text))
	}
	item["content"] = content
	return item
}
func callerToolFrames(h *Handle, call *CallerToolCall, candidate *stream.Buffer) error {
	if err := completeTextFrames(h, h.output, candidate); err != nil {
		return err
	}
	c := call.request.Call
	opening := map[string]any{"id": c.ItemID, "type": "function_call", "call_id": c.CallID, "name": c.Name, "arguments": ""}
	if c.Namespace != nil {
		opening["namespace"] = *c.Namespace
	}
	if err := appendModelFrame(candidate, "response.output_item.added", stream.Phase, map[string]any{"output_index": 1, "item": opening}); err != nil {
		return err
	}
	if err := appendModelFrame(candidate, "response.function_call_arguments.delta", stream.Phase, map[string]any{"output_index": 1, "item_id": c.ItemID, "delta": c.Arguments}); err != nil {
		return err
	}
	if err := appendModelFrame(candidate, "response.function_call_arguments.done", stream.Phase, map[string]any{"output_index": 1, "item_id": c.ItemID, "arguments": c.Arguments}); err != nil {
		return err
	}
	opening["arguments"], opening["status"] = c.Arguments, "completed"
	if err := appendModelFrame(candidate, "response.output_item.done", stream.Phase, map[string]any{"output_index": 1, "item": opening}); err != nil {
		return err
	}
	response := responseValue(h, h.output, "completed")
	response["model"] = call.request.Scope.Model
	response["output"] = []any{messageValue(h.output, "completed"), opening}
	// HTTP round completion deliberately does not close the Chat stream/turn.
	return appendModelFrame(candidate, "response.completed", stream.Phase, map[string]any{"response": response})
}

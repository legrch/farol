// Package responses encodes Chat frames for the EXISTING Responses transport.
// It opens no endpoint/socket and performs no Send, polling, writes or ACK.
package responses

import (
	"bytes"
	"encoding/json"

	"github.com/legrch/farol/modules/chat/contracts/conversation"
)

func Encode(frame conversation.Frame) ([]byte, error) {
	switch frame.Type {
	case "response.created", "response.output_item.added", "response.content_part.added",
		"response.output_text.delta", "response.output_text.done", "response.content_part.done",
		"response.output_item.done", "response.completed", "response.failed":
	default:
		return nil, &conversation.Failure{Code: "CHAT_RESPONSE_EVENT_INVALID", Source: "chat-responses", Retry: "never"}
	}
	var event struct {
		Type     string `json:"type"`
		Sequence uint64 `json:"sequence_number"`
	}
	if len(frame.JSON) > 64*1024 || json.Unmarshal(frame.JSON, &event) != nil || frame.Sequence == 0 || event.Sequence != frame.Sequence || event.Type != frame.Type {
		return nil, &conversation.Failure{Code: "CHAT_RESPONSE_EVENT_INVALID", Source: "chat-responses", Retry: "never"}
	}
	var compact bytes.Buffer
	if json.Compact(&compact, frame.JSON) != nil {
		return nil, &conversation.Failure{Code: "CHAT_RESPONSE_EVENT_INVALID", Source: "chat-responses", Retry: "never"}
	}
	result := append([]byte("event: "+frame.Type+"\ndata: "), compact.Bytes()...)
	return append(result, '\n', '\n'), nil
}

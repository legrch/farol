package conversation

import (
	"context"
	"encoding/json"

	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
)

// Independent consumer DTO for the one original consumptive issuance. It has
// no constructor accepting frame bytes/ranges as authority. All fields and
// payloads are detached copies; changing them cannot change the Go owner.
// Root binds/encodes it for one write. It is neither receipt nor consumption ACK.
type CallerDelivery struct {
	Context                     ComputerContext
	Scope                       CallerScope
	ProducerOperationID         string
	Call                        CallerFunctionCall
	FirstSequence, LastSequence uint64
	Frames                      []Frame
}

// IssueDelivery consumes the same original claimed pending call before reply.
// A lost reply or failed encoding/write is never retried. Later cancellation or
// freeze cannot prove that an already issued write did not reach its consumer.
// CheckDispatch/Events remain snapshots, not alternative write authority.
func (call *CallerToolCall) IssueDelivery(ctx context.Context) (*CallerDelivery, error) {
	if call == nil || call.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	original, err := call.current.IssueDelivery(ctx)
	if err != nil {
		return nil, failure(err)
	}
	out := &CallerDelivery{Context: fromComputerContext(original.Context), Scope: fromCallerScope(original.Scope), ProducerOperationID: original.ProducerOperationID, Call: fromCallerFunction(original.Call), FirstSequence: original.FirstSequence, LastSequence: original.LastSequence, Frames: make([]Frame, 0, len(original.Frames))}
	for _, frame := range original.Frames {
		var event struct {
			Type     string `json:"type"`
			Sequence uint64 `json:"sequence_number"`
		}
		if json.Unmarshal(frame.Data, &event) != nil || event.Type == "" || event.Sequence != frame.Sequence {
			return nil, failure(lifecycle.Unsettled)
		}
		out.Frames = append(out.Frames, Frame{Sequence: frame.Sequence, Type: event.Type, JSON: append([]byte(nil), frame.Data...)})
	}
	return out, nil
}

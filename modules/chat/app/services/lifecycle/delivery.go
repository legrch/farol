package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
)

// CallerDelivery is the one original issuance, not provider consumption or an
// output/return ACK. Correlation is captured at BeginCallerTool. Frames are
// independent copies of the bounded, owner-generated original completion group.
// Mutating a returned DTO cannot change the retained source or grant another issue.
type CallerDelivery struct {
	Context                     port.ComputerContext
	Scope                       port.CallerScope
	ProducerOperationID         string
	Call                        port.CallerFunctionCall
	FirstSequence, LastSequence uint64
	Frames                      []stream.Frame
}

// IssueDelivery consumes the SAME already-claimed pending call once under its
// actual owner gate, before returning any bytes. There is no callback, journal,
// browser/Computer effect, ACK or owner gate held across IO. The selected HTTP
// consumer must bind this issuance to one bounded synchronous original write;
// an earlier issued write may be in flight when cancel/freeze wins later.
// Loss/encoding/write/drain failure cannot reissue, renew or replay the group.
func (call *CallerToolCall) IssueDelivery(ctx context.Context) (*CallerDelivery, error) {
	if !call.valid() || ctx == nil {
		return nil, Invalid
	}
	c := call.original.conversation
	s, h := c.owner, c.handle
	if s.deps.Gate == nil || s.queue == nil || h.owner != s {
		return nil, Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := call.checkDispatchCurrent(ctx); err != nil {
		return nil, err
	}
	if call.deliveryIssued {
		return nil, Unsettled
	}
	// Consume even if the originally published bytes became unavailable. They
	// must never be reconstructed from caller-selected Events or a second attempt.
	call.deliveryIssued = true
	first, last := call.deliveryFirst, call.deliveryLast
	if h.frames == nil {
		return nil, Unavailable
	}
	if first == 0 || last < first || last-first >= uint64(stream.DefaultLimits().Frames) {
		return nil, stream.Gap
	}
	retained, err := h.frames.Replay(streamScope(h.fixed))
	if err != nil {
		return nil, err
	}
	group := make([]stream.Frame, 0, int(last-first+1))
	for _, f := range retained {
		if f.Sequence < first || f.Sequence > last {
			continue
		}
		if f.Sequence != first+uint64(len(group)) {
			return nil, stream.Gap
		}
		// Replay already deep-copies each payload; retain only this original span.
		group = append(group, f)
	}
	if len(group) != int(last-first+1) {
		return nil, stream.Gap
	}
	if ctx.Err() != nil {
		return nil, Cancelled
	}
	return &CallerDelivery{Context: call.request.Context, Scope: call.request.Scope, ProducerOperationID: call.request.ProducerOperationID, Call: cloneCallerFunction(call.request.Call), FirstSequence: first, LastSequence: last, Frames: group}, nil
}

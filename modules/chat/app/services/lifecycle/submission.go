package lifecycle

import (
	"context"
	"math"

	"github.com/legrch/farol/modules/chat/domain/turn"
)

// SubmissionState describes only the actual owner's live Send-intent snapshot.
// It is not provider acceptance, cancellation evidence or replay-guard release
// authority. No state authorizes a replacement request or a second Send.
type SubmissionState string

const (
	SubmissionNotDispatched   SubmissionState = "not-dispatched"
	SubmissionIntentCommitted SubmissionState = "intent-committed"
	SubmissionUnknown         SubmissionState = "unknown"
)

// SubmissionState performs no journal/history read, browser effect or mutation.
// In particular, not-dispatched does NOT withdraw a queued/prepared handle: it
// can still Send after this read. A consumer needs a separate known withdrawal
// proof before releasing its external initial-request deduplication record.
func (c *Conversation) SubmissionState(ctx context.Context) (SubmissionState, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return SubmissionUnknown, Invalid
	}
	s, h := c.owner, c.handle
	if s.deps.Gate == nil || s.queue == nil || h.owner != s {
		return SubmissionUnknown, Invalid
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if ctx.Err() != nil {
		return SubmissionUnknown, Cancelled
	}
	if s.handles[h.fixed.OperationID] != h || h.conversation != c {
		return SubmissionUnknown, Mismatch
	}
	// A candidate or uncertain effect cannot be interpreted from the last
	// published queue alone. Read-only observation never repairs sticky unknown.
	if s.unknown || s.pending != nil || s.retiring || s.retired != nil || h.observing || s.revision == math.MaxUint64 || s.fence == math.MaxUint64 {
		return SubmissionUnknown, nil
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		return SubmissionUnknown, Unsettled
	}
	state := SubmissionUnknown
	switch view.Phase {
	case turn.Admitted, turn.Pending, turn.Running, turn.AwaitingOwner, turn.ResultReady, turn.Delivered, turn.Cancelled:
		if view.Result.Outcome != turn.UnknownOutcome {
			state = SubmissionNotDispatched
			if view.SendIntent {
				state = SubmissionIntentCommitted
			}
		}
	}
	if ctx.Err() != nil {
		return SubmissionUnknown, Cancelled
	}
	return state, nil
}

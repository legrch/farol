package conversation

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
)

// Independent consumer DTO, explicitly mapped from the actual Chat owner.
// These closed states describe intent only; none is a release/retry grant.
type SubmissionState string

const (
	SubmissionNotDispatched   SubmissionState = "not-dispatched"
	SubmissionIntentCommitted SubmissionState = "intent-committed"
	SubmissionUnknown         SubmissionState = "unknown"
)

// SubmissionState is a read-only snapshot, not provider delivery or withdrawal
// proof. A queued/prepared handle reporting not-dispatched can still Send later.
// Never release an external replay guard from this state: known terminal
// withdrawal requires a separate owning operation and correlated proof.
func (h *Handle) SubmissionState(ctx context.Context) (SubmissionState, error) {
	if h == nil || h.current == nil {
		return SubmissionUnknown, failure(lifecycle.Invalid)
	}
	state, err := h.current.SubmissionState(ctx)
	if err != nil {
		return SubmissionUnknown, failure(err)
	}
	switch state {
	case lifecycle.SubmissionNotDispatched:
		return SubmissionNotDispatched, nil
	case lifecycle.SubmissionIntentCommitted:
		return SubmissionIntentCommitted, nil
	case lifecycle.SubmissionUnknown:
		return SubmissionUnknown, nil
	default:
		return SubmissionUnknown, failure(lifecycle.Unsettled)
	}
}

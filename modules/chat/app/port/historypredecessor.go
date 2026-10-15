package port

import "context"

// HistoryPredecessorView is verified original completion metadata plus the
// current local read scope. It contains no payload, live handle or Send grant.
// Copying this value preserves provenance only, never current read authority.
type HistoryPredecessorView struct {
	Binding                                                     TurnBinding
	ResultID                                                    string
	ProviderConversationID, ProviderUserTurnID, ProviderReplyID string
	Requested                                                   Selection
	Observed                                                    SelectionFacts
	Evidence                                                    SelectionEvidence
	CurrentScope                                                HistoryReadScope
}

// HistoryPredecessor is an opaque read witness minted by the handoff owner
// after exact latest-ancestor selection and durable-result verification. It is
// not Send, admission, Follow or ACK authority. A view cannot mint a witness.
// WithCurrent calls inspect exactly once on success under the handoff and
// original reader gates, in that order, and rechecks before returning. inspect
// must be synchronous, perform no IO/effects and never reenter either owner.
// An error, including a late withdrawal, grants no current-use authority even
// if inspect ran. Revocation/reactivation cannot renew the captured lease.
type HistoryPredecessor interface {
	WithCurrent(context.Context, func(HistoryPredecessorView) error) error
}

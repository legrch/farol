package conversation

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
)

// ContinueRetainedAuthorized admits a new prompt through the existing lifecycle
// using the exact reader's opaque predecessor and a fresh final Send guard.
// History supplies read provenance only; admission does not dispatch the prompt.
func (f *Facade) ContinueRetainedAuthorized(ctx context.Context, history *History, conversationID string, input Input, authorization SendAuthorization) (*Handle, error) {
	if f == nil || f.service == nil || authorization == nil {
		return nil, failure(lifecycle.Invalid)
	}
	if history == nil || history.reader == nil {
		return nil, historyFailure(handoff.Refused)
	}
	predecessor, err := history.reader.Predecessor(ctx, conversationID)
	if err != nil {
		return nil, historyFailure(err)
	}
	c, err := f.service.ContinueConversation(ctx, predecessor, toInput(input), mapSendAuthorization(authorization))
	if c == nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, failure(err)
}

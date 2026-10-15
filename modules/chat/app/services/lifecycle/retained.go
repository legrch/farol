package lifecycle

import (
	"context"
	"encoding/json"

	"github.com/legrch/farol/modules/chat/app/port"
)

// A retained continuation keeps provenance and its original read witness apart
// from the mandatory fresh disclosure guard. It restores no live handle.
type retainedContinuation struct {
	witness port.HistoryPredecessor
	view    port.HistoryPredecessorView
}

func predecessorView(ctx context.Context, witness port.HistoryPredecessor) (port.HistoryPredecessorView, error) {
	var view port.HistoryPredecessorView
	if ctx == nil || witness == nil {
		return view, Invalid
	}
	calls := 0
	err := witness.WithCurrent(ctx, func(v port.HistoryPredecessorView) error {
		calls++
		view = v
		return nil
	})
	if err != nil {
		return port.HistoryPredecessorView{}, err
	}
	if calls != 1 || ctx.Err() != nil {
		return port.HistoryPredecessorView{}, Unavailable
	}
	return view, nil
}

func (r *retainedContinuation) current(ctx context.Context) error {
	if r == nil {
		return nil
	}
	v, err := predecessorView(ctx, r.witness)
	if err != nil {
		return err
	}
	if v != r.view {
		return Mismatch
	}
	return nil
}

func sameRetained(a, b *retainedContinuation) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.view == b.view
}

// ContinueConversation creates a new turn for one verified retained provider
// conversation. A caller-supplied view or provider ID cannot replace the witness.
// Existing CID ownership and uncertain journal writes remain owned by admit.
func (s *Service) ContinueConversation(ctx context.Context, witness port.HistoryPredecessor, input port.ConversationInput, authorization port.SendAuthorization) (*Conversation, error) {
	if s == nil || authorization == nil {
		return nil, Invalid
	}
	v, err := predecessorView(ctx, witness)
	if err != nil {
		return nil, err
	}
	b, old := input.Binding, v.Binding
	if !validBinding(old) || v.CurrentScope != (port.HistoryReadScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID}) || old.ProfileID != b.ProfileID || old.OwnerID != b.OwnerID || old.BackendGeneration == b.BackendGeneration || old.OperationID == b.OperationID || old.TurnID == b.TurnID || !validID(v.ResultID) || input.Selection != v.Requested || v.Evidence.Requested != v.Requested || v.Evidence.Observed != v.Observed {
		return nil, Mismatch
	}
	// Recovery preserves the original configured mapping just like Follow.
	// Zero remains unknown; a new request cannot invent or discard provenance.
	if input.Resolution != v.Evidence.Resolution {
		return nil, Mismatch
	}
	// The old record has no Required mask. A known effort observation cannot be
	// weakened to optional; models without an effort control remain supported.
	minimum := port.RequiredControls{Model: true, Effort: v.Observed.Effort.Known(), Mode: v.Requested.Mode != "", Connector: v.Requested.ToolsEnabled}
	if !v.Observed.Matches(v.Requested, minimum) || !input.Required.Valid(input.Selection) || (minimum.Effort && !input.Required.Effort) {
		return nil, Mismatch
	}
	r := &retainedContinuation{witness: witness, view: v}
	target := port.ConversationTarget{Mode: port.OwnedSaved, Required: input.Required, ConversationID: v.ProviderConversationID, PreviousUserTurnID: v.ProviderUserTurnID, PreviousReplyID: v.ProviderReplyID, Selection: input.Selection, Resolution: input.Resolution}
	guard := func(ctx context.Context, current port.SendCurrent) error {
		if err := r.current(ctx); err != nil {
			return err
		}
		// Authorization may qualify Computer outside the read gate. Only its
		// final synchronous capability callback nests reader -> Chat guards.
		if err := authorization(ctx, &retainedSendCurrent{retained: r, current: current}); err != nil {
			return err
		}
		// A consumer may yield after its last capability callback. Refuse a
		// withdrawal observed before it returns to the dispatch owner.
		return r.current(ctx)
	}
	return s.createConversationFrom(ctx, input, target, nil, guard, r)
}

// Ordinary new/follow intent digests retain their existing representation.
// Retained lineage is bound to the new turn without serializing its payload.
func (s *Service) conversationDigest(binding port.TurnBinding, target port.ConversationTarget, prompt string, r *retainedContinuation) (string, error) {
	if r == nil {
		return s.intentDigest(binding, target, prompt)
	}
	bytes, err := json.Marshal(struct {
		Version     int
		Binding     port.TurnBinding
		Target      port.ConversationTarget
		Prompt      string
		Predecessor port.HistoryPredecessorView
	}{2, binding, target, prompt, r.view})
	if err != nil || s.deps.IntentDigests == nil {
		return "", Invalid
	}
	return s.deps.IntentDigests.Digest(bytes)
}

type retainedSendCurrent struct {
	retained *retainedContinuation
	current  port.SendCurrent
}

func (c *retainedSendCurrent) inspect(ctx context.Context, callback func() error) error {
	if c == nil || c.retained == nil || c.current == nil || callback == nil {
		return Invalid
	}
	calls := 0
	var callbackErr error
	err := c.retained.witness.WithCurrent(ctx, func(v port.HistoryPredecessorView) error {
		calls++
		if calls != 1 || v != c.retained.view {
			callbackErr = Mismatch
			return callbackErr
		}
		callbackErr = callback()
		return callbackErr
	})
	if err != nil {
		return err
	}
	if calls != 1 || ctx == nil || ctx.Err() != nil {
		return Unavailable
	}
	return callbackErr
}

func (c *retainedSendCurrent) WithCurrent(ctx context.Context, inspect func(port.TurnBinding) error) error {
	if inspect == nil {
		return Invalid
	}
	return c.inspect(ctx, func() error { return c.current.WithCurrent(ctx, inspect) })
}

func (c *retainedSendCurrent) AccountSnapshot(ctx context.Context) (port.AccountObservation, error) {
	var out port.AccountObservation
	err := c.inspect(ctx, func() error {
		var err error
		out, err = c.current.AccountSnapshot(ctx)
		return err
	})
	if err != nil {
		return port.AccountObservation{}, err
	}
	return out, nil
}

package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// historyPredecessor retains only immutable provenance and its original read
// lease. It holds no payload, result store, admission or execution capability.
type historyPredecessor struct {
	origin HistoryOrigin
	lease  port.HistoryReadLease
	view   port.HistoryPredecessorView
}

// Predecessor mints a read witness for the exact latest completed retained
// owner/CID pair. Selection and durable verification share one original lease;
// public Latest/Read calls would independently admit and cannot build this proof.
func (r *HistoryReader) Predecessor(ctx context.Context, conversationID string) (port.HistoryPredecessor, error) {
	if !validID(conversationID) {
		return nil, Invalid
	}
	lease, scope, err := r.admit(ctx)
	if err != nil {
		return nil, err
	}
	if r.origin == nil {
		return nil, Refused
	}
	s := r.origin.owner
	s.guard.Lock()
	err = r.currentLocked(ctx, lease, scope)
	var match *port.HistoryMatch
	if err == nil {
		match, err = r.store.HistoryTail(ctx, r.origin.anchor, scope.OwnerID, conversationID)
	}
	s.guard.Unlock()
	if err != nil {
		return nil, err
	}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	if match == nil || !r.match(*match, scope) || match.Turn.Snapshot.Binding.Document.ConversationID != conversationID {
		return nil, Refused
	}
	retained, err := r.readRetained(ctx, lease, scope, *match)
	if err != nil {
		return nil, err
	}
	c := retained.Conversation
	p := &historyPredecessor{origin: *r.origin, lease: lease, view: port.HistoryPredecessorView{
		Binding: retained.Binding, ResultID: retained.Result.ID,
		ProviderConversationID: c.ProviderConversationID, ProviderUserTurnID: c.ProviderUserTurnID, ProviderReplyID: c.ProviderReplyID,
		Requested: c.Requested, Observed: c.Observed, Evidence: c.Evidence, CurrentScope: scope,
	}}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *historyPredecessor) WithCurrent(ctx context.Context, inspect func(port.HistoryPredecessorView) error) error {
	if p == nil || ctx == nil || inspect == nil || p.lease == nil || p.origin.owner == nil || p.origin.owner.guard == nil || p.origin.anchor.HeadDigest == ([32]byte{}) {
		return Invalid
	}
	s := p.origin.owner
	s.guard.Lock()
	defer s.guard.Unlock()
	// Reuse the same origin/head and scope checks without keeping the reader's
	// result store or authority factory in the witness.
	r := HistoryReader{origin: &p.origin}
	if err := r.currentLocked(ctx, p.lease, p.view.CurrentScope); err != nil {
		return err
	}
	calls := 0
	inspections := 0
	var callbackErr error
	err := p.lease.WithCurrent(ctx, func(scope port.HistoryReadScope) error {
		calls++
		if calls != 1 || scope != p.view.CurrentScope || ctx.Err() != nil {
			callbackErr = Refused
			return callbackErr
		}
		if err := r.available(ctx); err != nil {
			callbackErr = err
			return err
		}
		inspections++
		callbackErr = inspect(p.view)
		return callbackErr
	})
	// Check even after callback failure. A late withdrawal or head change must
	// not be hidden by a consumer error or renew this proof through readmission.
	if currentErr := r.currentLocked(ctx, p.lease, p.view.CurrentScope); currentErr != nil {
		return currentErr
	}
	if calls != 1 || inspections != 1 {
		return Refused
	}
	if err != nil {
		return err
	}
	return callbackErr
}

var _ port.HistoryPredecessor = (*historyPredecessor)(nil)

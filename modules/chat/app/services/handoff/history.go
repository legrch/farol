package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// HistoryOrigin is minted only by a known successful Consume. It is not a live
// conversation or execution capability. Trusted boot must not expose a reader
// until the exact paired journal successor and other startup owners open.
type HistoryOrigin struct {
	owner  *Service
	anchor port.HistoryAnchor
}

type HistoryDependencies struct {
	Authority        port.HistoryReadAuthority
	Results          port.DurableResults
	ResultBytesLimit int
}

type HistoryReader struct {
	origin *HistoryOrigin
	deps   HistoryDependencies
	store  port.HandoffHistoryStore
}

// HistorySummary is an original completed result reference. It contains no
// payload, physical publication, live handle, admission or provider command.
type HistorySummary struct {
	Key                    port.HistoryKey
	Binding                port.TurnBinding
	ResultID               string
	ProviderConversationID string
}
type HistoryListing struct {
	Offset, Total uint32
	Entries       []HistorySummary
}

func NewHistoryReader(origin *HistoryOrigin, deps HistoryDependencies) (*HistoryReader, error) {
	if origin == nil || origin.owner == nil || origin.owner.guard == nil || origin.anchor.HeadDigest == ([32]byte{}) || deps.Authority == nil || deps.Results == nil || deps.ResultBytesLimit < 1 || deps.ResultBytesLimit > port.MaxResultRecordBytes {
		return nil, Invalid
	}
	store, ok := origin.owner.store.(port.HandoffHistoryStore)
	if !ok {
		return nil, Refused
	}
	return &HistoryReader{origin: origin, deps: deps, store: store}, nil
}

func historyScope(ctx context.Context, lease port.HistoryReadLease) (port.HistoryReadScope, error) {
	var scope port.HistoryReadScope
	if ctx == nil || lease == nil {
		return scope, Invalid
	}
	calls := 0
	err := lease.WithCurrent(ctx, func(current port.HistoryReadScope) error {
		calls++
		if calls != 1 || !validID(current.ProfileID) || !validID(current.BackendGeneration) || !validID(current.OwnerID) {
			return Refused
		}
		scope = current
		return nil
	})
	if err != nil || calls != 1 || ctx.Err() != nil {
		return port.HistoryReadScope{}, Refused
	}
	return scope, nil
}

func (r *HistoryReader) admit(ctx context.Context) (port.HistoryReadLease, port.HistoryReadScope, error) {
	if r == nil || ctx == nil || ctx.Err() != nil {
		return nil, port.HistoryReadScope{}, Invalid
	}
	lease, err := r.deps.Authority.AdmitHistoryRead(ctx)
	if err != nil {
		return nil, port.HistoryReadScope{}, err
	}
	scope, err := historyScope(ctx, lease)
	if err != nil || scope.ProfileID != r.origin.anchor.Consumption.Next.ProfileID || scope.BackendGeneration != r.origin.anchor.Consumption.Next.BackendGeneration {
		return nil, port.HistoryReadScope{}, Refused
	}
	return lease, scope, nil
}

// Caller holds the service's dedicated guard. A later publication invalidates
// the old read origin even if an incorrectly composed authority stays active.
func (r *HistoryReader) available(ctx context.Context) error {
	s := r.origin.owner
	if err := s.check(ctx); err != nil {
		return err
	}
	if s.knownHead != r.origin.anchor.HeadDigest {
		return Refused
	}
	return nil
}
func (r *HistoryReader) current(ctx context.Context, lease port.HistoryReadLease, expected port.HistoryReadScope) error {
	r.origin.owner.guard.Lock()
	defer r.origin.owner.guard.Unlock()
	return r.currentLocked(ctx, lease, expected)
}

// Check after any wait for the handoff gate. Lock order is handoff then reader;
// authority callbacks only copy scope and must not reenter either owner. No IO
// occurs under the reader's callback, and a gate wait never renews a stale lease.
func (r *HistoryReader) currentLocked(ctx context.Context, lease port.HistoryReadLease, expected port.HistoryReadScope) error {
	now, err := historyScope(ctx, lease)
	if err != nil || now != expected {
		return Refused
	}
	return r.available(ctx)
}

func (r *HistoryReader) match(v port.HistoryMatch, scope port.HistoryReadScope) bool {
	b := v.Origin.Binding
	current := r.origin.anchor.Consumption.NextBinding
	return v.Anchor == r.origin.anchor && validBinding(b) && validID(v.Origin.HandoffID) && v.Origin.ReceiptDigest != ([32]byte{}) &&
		b.ProfileID == scope.ProfileID && b.BackendGeneration != scope.BackendGeneration && b.BuildID == current.BuildID && b.ParentRoot == current.ParentRoot && b.ChatRoot == current.ChatRoot &&
		v.Turn.Binding.OwnerID == scope.OwnerID && completedRetained(v.Turn, port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, b.ChatRoot, v.PreviousRevision)
}

func (r *HistoryReader) List(ctx context.Context, offset uint32) (*HistoryListing, error) {
	if offset > port.MaxRetainedResults {
		return nil, Invalid
	}
	lease, scope, err := r.admit(ctx)
	if err != nil {
		return nil, err
	}
	s := r.origin.owner
	s.guard.Lock()
	err = r.currentLocked(ctx, lease, scope)
	var page *port.HistoryPage
	if err == nil {
		page, err = r.store.HistoryPage(ctx, r.origin.anchor, scope.OwnerID, offset)
	}
	s.guard.Unlock()
	if err != nil {
		return nil, err
	}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	if page == nil || page.Anchor != r.origin.anchor || page.Offset != offset || page.Total > port.MaxRetainedResults || offset > page.Total || page.Entries == nil || len(page.Entries) != int(min(uint32(port.HistoryPageSize), page.Total-offset)) {
		return nil, Refused
	}
	out := &HistoryListing{Offset: offset, Total: page.Total, Entries: make([]HistorySummary, 0, len(page.Entries))}
	seen := make(map[port.HistoryKey]bool, len(page.Entries))
	for _, v := range page.Entries {
		key := port.HistoryKey{BackendGeneration: v.Turn.Binding.BackendGeneration, OperationID: v.Turn.Binding.OperationID}
		if !r.match(v, scope) || seen[key] {
			return nil, Refused
		}
		seen[key] = true
		out.Entries = append(out.Entries, HistorySummary{Key: key, Binding: v.Turn.Binding, ResultID: v.Turn.Snapshot.Result.ID, ProviderConversationID: v.Turn.Snapshot.Binding.Document.ConversationID})
	}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *HistoryReader) Read(ctx context.Context, key port.HistoryKey) (*port.ConversationResult, error) {
	if !validID(key.BackendGeneration) || !validID(key.OperationID) {
		return nil, Invalid
	}
	lease, scope, err := r.admit(ctx)
	if err != nil {
		return nil, err
	}
	if key.BackendGeneration == scope.BackendGeneration {
		return nil, Refused
	}
	s := r.origin.owner
	s.guard.Lock()
	err = r.currentLocked(ctx, lease, scope)
	var match *port.HistoryMatch
	if err == nil {
		match, err = r.store.HistoryFind(ctx, r.origin.anchor, scope.OwnerID, key)
	}
	s.guard.Unlock()
	if err != nil {
		return nil, err
	}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	if match == nil {
		return nil, Refused
	}
	v := *match
	if !r.match(v, scope) || v.Turn.Binding.BackendGeneration != key.BackendGeneration || v.Turn.Binding.OperationID != key.OperationID {
		return nil, Refused
	}
	read := port.ResultRead{Binding: v.Turn.Binding, Result: v.Turn.Snapshot.Result, Publication: v.Turn.ResultPublication}
	retained, err := r.deps.Results.Read(ctx, read)
	if err != nil {
		return nil, err
	}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	if retained == nil || retained.Binding != read.Binding || retained.Result != read.Result || len(retained.Payload) > r.deps.ResultBytesLimit || !retained.Conversation.Valid(retained.Result, retained.Payload) || !retained.Conversation.Complete || retained.Conversation.ProviderConversationID != v.Turn.Snapshot.Binding.Document.ConversationID {
		return nil, Refused
	}
	c := retained.Conversation
	out := &port.ConversationResult{Binding: retained.Binding, ResultID: retained.Result.ID, ProviderConversationID: c.ProviderConversationID, ProviderUserTurnID: c.ProviderUserTurnID, ProviderReplyID: c.ProviderReplyID, Requested: c.Requested, Observed: c.Observed, Evidence: c.Evidence, Text: string(retained.Payload), Phase: string(v.Turn.Snapshot.Phase), Outcome: string(retained.Result.Outcome), Code: retained.Result.Code, Complete: true, Acknowledged: true}
	if err := r.current(ctx, lease, scope); err != nil {
		return nil, err
	}
	return out, nil
}

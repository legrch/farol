// Package contextsource maps an original live Chat source lease. It owns no
// history database, conversation, account grant, checkpoint writer or dispatcher.
package contextsource

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/services/contextcheckpoint"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/contextbudget"
)

// DisclosureLease is issued by the existing selected-account owner. WithCurrent
// synchronously observes the SAME activation and full selected capability epoch,
// calling inspect exactly once under that owner's guard. The adapter cannot
// mint, refresh or reacquire it. Opaque IDs and stored selection are not grants.
// Callback bodies copy values only; they must not do IO or reenter either owner.
type DisclosureLease interface {
	WithCurrent(context.Context, func(contextbudget.Binding) error) error
}

type Source struct {
	original   *lifecycle.ContextLease
	disclosure DisclosureLease
	binding    contextbudget.Binding
	source     contextbudget.Source
	reference  contextbudget.SourceRef
}

var _ contextcheckpoint.Source = (*Source)(nil)

// New pins an original source and original disclosure lease. It never reads a
// completed-only catalogue or reconstructs discarded prompts/tool records.
func New(ctx context.Context, original *lifecycle.ContextLease, disclosure DisclosureLease, binding contextbudget.Binding, digests contextcheckpoint.Digester) (*Source, error) {
	if ctx == nil || ctx.Err() != nil || original == nil || disclosure == nil || !binding.Valid() || digests == nil {
		return nil, contextcheckpoint.Invalid
	}
	s := &Source{original: original, disclosure: disclosure, binding: binding}
	if err := s.checkDisclosure(ctx); err != nil {
		return nil, err
	}
	var snapshot lifecycle.ContextSnapshot
	calls := 0
	if err := original.WithCurrent(ctx, func(current lifecycle.ContextSnapshot) error { calls++; snapshot = current; return nil }); err != nil || calls != 1 {
		return nil, contextbudget.Stale
	}
	selection := snapshot.Selection
	if selection.AccountID != binding.AccountID || selection.Provider != binding.Provider || selection.ModelID != binding.ModelID || selection.Effort != binding.Effort || len(snapshot.Turns) == 0 {
		return nil, contextbudget.Stale
	}
	s.source = contextbudget.Source{Binding: binding, Revision: snapshot.Revision, Events: []contextbudget.Event{}}
	for i, item := range snapshot.Turns {
		b := item.Binding
		if b.ProfileID != binding.ProfileID || b.BackendGeneration != binding.BackendGeneration || b.OwnerID != binding.OwnerID {
			return nil, contextbudget.Stale
		}
		turn := contextbudget.Turn{SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, OperationID: b.OperationID, TurnGeneration: b.TurnGeneration}
		// Completed exchanges preserve the original provider event IDs. The last
		// unsent user event uses its actual original Chat admission's turn ID;
		// it is never presented as a provider/browser identifier or reply.
		userID := item.ProviderUserTurnID
		if !item.Complete {
			if i != len(snapshot.Turns)-1 {
				return nil, contextcheckpoint.Invalid
			}
			userID = b.TurnID
		}
		s.source.Events = append(s.source.Events, contextbudget.Event{ID: userID, Sequence: uint64(len(s.source.Events) + 1), Turn: turn, Kind: contextbudget.User, Text: item.Prompt})
		if item.Complete {
			s.source.Events = append(s.source.Events, contextbudget.Event{ID: item.ProviderReplyID, Sequence: uint64(len(s.source.Events) + 1), Turn: turn, Kind: contextbudget.Assistant, Text: item.Text})
		}
	}
	raw, err := contextbudget.CanonicalSource(s.source)
	if err != nil {
		return nil, err
	}
	if len(raw) > contextbudget.MaxSourceBytes {
		return nil, contextbudget.SourceLimit
	}
	digest, err := digests.Digest(raw)
	if err != nil || !contextbudget.Digest(digest) {
		return nil, contextcheckpoint.Invalid
	}
	first, last := s.source.Events[0], s.source.Events[len(s.source.Events)-1]
	s.reference = contextbudget.SourceRef{Binding: binding, Revision: s.source.Revision, FirstSequence: first.Sequence, LastSequence: last.Sequence, FirstEventID: first.ID, LastEventID: last.ID, SHA256: digest}
	if err = s.checkCurrent(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Source) checkDisclosure(ctx context.Context) error {
	if s == nil || ctx == nil || ctx.Err() != nil || s.disclosure == nil {
		return contextbudget.Stale
	}
	calls := 0
	err := s.disclosure.WithCurrent(ctx, func(now contextbudget.Binding) error {
		calls++
		if calls != 1 || now != s.binding {
			return contextbudget.Stale
		}
		return nil
	})
	if err != nil || calls != 1 || ctx.Err() != nil {
		return contextbudget.Stale
	}
	return nil
}
func (s *Source) checkCurrent(ctx context.Context) error {
	if err := s.checkDisclosure(ctx); err != nil {
		return err
	}
	calls := 0
	if s.original == nil {
		return contextbudget.Stale
	}
	if err := s.original.WithCurrent(ctx, func(lifecycle.ContextSnapshot) error { calls++; return nil }); err != nil || calls != 1 {
		return contextbudget.Stale
	}
	return s.checkDisclosure(ctx)
}
func (s *Source) Read(ctx context.Context, binding contextbudget.Binding) (contextbudget.Source, error) {
	if s == nil || binding != s.binding {
		return contextbudget.Source{}, contextbudget.Stale
	}
	if err := s.checkCurrent(ctx); err != nil {
		return contextbudget.Source{}, err
	}
	copy := s.source
	copy.Events = append([]contextbudget.Event{}, s.source.Events...)
	return copy, nil
}
func (s *Source) Check(ctx context.Context, reference contextbudget.SourceRef) error {
	if s == nil || reference != s.reference {
		return contextbudget.Stale
	}
	return s.checkCurrent(ctx)
}

// WithCurrent holds the exact original lifecycle source gate around a no-IO
// callback. It verifies the complete immutable source reference, not InputHash.
// This is a source fence only, not disclosure/dispatch authority. Composition
// must nest the SAME selected account's guard inside it (source -> account),
// and must not reenter Read/Check, context/model services or either owner.
func (s *Source) WithCurrent(ctx context.Context, reference contextbudget.SourceRef, inspect func() error) error {
	if s == nil || ctx == nil || ctx.Err() != nil || s.original == nil || inspect == nil || reference != s.reference {
		return contextbudget.Stale
	}
	calls := 0
	err := s.original.WithCurrent(ctx, func(lifecycle.ContextSnapshot) error {
		calls++
		if calls != 1 {
			return contextbudget.Stale
		}
		return inspect()
	})
	if err != nil {
		return err
	}
	if calls != 1 || ctx.Err() != nil {
		return contextbudget.Stale
	}
	return nil
}

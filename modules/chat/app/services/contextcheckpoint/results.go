package contextcheckpoint

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/contextbudget"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// OriginalResults names owner-qualified terminal publications. It must also
// supply original prompts/tool rounds; retained answer text cannot invent them.
type OriginalResults interface {
	Original(context.Context, contextbudget.Binding) (OriginalSnapshot, error)
	CheckOriginal(context.Context, contextbudget.Binding, uint64) error
}
type OriginalSnapshot struct {
	Source  contextbudget.Source
	Replies []RetainedReply
}
type RetainedReply struct {
	EventID string
	Read    port.ResultRead
}

// ResultsSource reuses the actual Chat DurableResults read port for completed
// answer payloads. Unresolved tool transcripts remain in the original source.
// It does not scan storage or qualify orphan records as accepted results.
type ResultsSource struct {
	Originals OriginalResults
	Results   port.DurableResults
}

func (a ResultsSource) Read(ctx context.Context, b contextbudget.Binding) (contextbudget.Source, error) {
	if ctx == nil || ctx.Err() != nil || a.Originals == nil || a.Results == nil || !b.Valid() {
		return contextbudget.Source{}, Invalid
	}
	snap, err := a.Originals.Original(ctx, b)
	if err != nil {
		return contextbudget.Source{}, Unavailable
	}
	s := snap.Source
	s.Events = append([]contextbudget.Event{}, s.Events...)
	if s.Binding != b || s.Revision == 0 || len(s.Events) > contextbudget.MaxEvents || len(snap.Replies) > len(s.Events) || a.Originals.CheckOriginal(ctx, b, s.Revision) != nil || ctx.Err() != nil {
		return contextbudget.Source{}, contextbudget.Stale
	}
	index := map[string]int{}
	for i, e := range s.Events {
		if _, ok := index[e.ID]; ok {
			return contextbudget.Source{}, Invalid
		}
		index[e.ID] = i
	}
	seen := map[string]bool{}
	for _, reply := range snap.Replies {
		i, ok := index[reply.EventID]
		if !ok || seen[reply.EventID] {
			return contextbudget.Source{}, Invalid
		}
		seen[reply.EventID] = true
		e := s.Events[i]
		read := reply.Read
		binding := read.Binding
		if e.Kind != contextbudget.Assistant || e.Text != "" || binding.ProfileID != b.ProfileID || binding.BackendGeneration != b.BackendGeneration || binding.OwnerID != b.OwnerID || e.Turn != (contextbudget.Turn{SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch, ParticipantID: binding.ParticipantID, TurnID: binding.TurnID, OperationID: binding.OperationID, TurnGeneration: binding.TurnGeneration}) || read.Result.Outcome != turn.Completed {
			return contextbudget.Source{}, Invalid
		}
		retained, err := a.Results.Read(ctx, read)
		if err != nil || retained == nil || ctx.Err() != nil || a.Originals.CheckOriginal(ctx, b, s.Revision) != nil {
			return contextbudget.Source{}, Unavailable
		}
		if retained.Binding != read.Binding || retained.Result != read.Result || len(retained.Payload) > contextbudget.MaxEventBytes || !retained.Conversation.Valid(retained.Result, retained.Payload) || !retained.Conversation.Complete {
			return contextbudget.Source{}, Invalid
		}
		selection := retained.Conversation.Requested
		if selection.AccountID != b.AccountID || selection.Provider != b.Provider || selection.ModelID != b.ModelID || selection.Effort != b.Effort {
			return contextbudget.Source{}, contextbudget.Stale
		}
		s.Events[i].Text = string(retained.Payload)
	}
	if ctx.Err() != nil || a.Originals.CheckOriginal(ctx, b, s.Revision) != nil {
		return contextbudget.Source{}, contextbudget.Stale
	}
	return s, nil
}
func (a ResultsSource) Check(ctx context.Context, r contextbudget.SourceRef) error {
	if a.Originals == nil || ctx == nil || ctx.Err() != nil || !r.Valid() {
		return Invalid
	}
	return a.Originals.CheckOriginal(ctx, r.Binding, r.Revision)
}

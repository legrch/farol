package task

// Execution metadata belongs to an existing dispatch, never a model transcript.
const EventCapacity = 64
const EventPageLimit = 32

type EventKind string

const (
	ProviderStarted  EventKind = "provider_started"
	ToolStarted      EventKind = "tool_started"
	ToolFinished     EventKind = "tool_finished"
	CheckpointReady  EventKind = "checkpoint_ready"
	ModelClaim       EventKind = "model_claim"
	ProviderTerminal EventKind = "provider_terminal"
)

type EvidenceSource string

const (
	RuntimeEvidence     EvidenceSource = "provider_runtime"
	ToolReceiptEvidence EvidenceSource = "provider_tool_receipt"
	AdvisoryEvidence    EvidenceSource = "advisory_model"
)

type ExecutionEvent struct {
	RunID, DispatchID, EventID, StreamID                  string
	Generation, SourceSequence, Sequence, TimestampMillis uint64
	Kind                                                  EventKind
	ReportedLifecycle                                     Lifecycle
	Source                                                EvidenceSource
	Reference                                             Reference
	ItemID                                                string
	HasExitCode                                           bool
	ExitCode                                              int
	PlanSteps, CompletedSteps                             uint16
}

func (e ExecutionEvent) Valid(provider Provider) bool {
	if !ID(e.RunID) || !ID(e.DispatchID) || !ID(e.EventID) || !ID(e.StreamID) || e.Generation == 0 || e.Generation > 9007199254740991 || e.SourceSequence == 0 || e.SourceSequence > 9007199254740991 || e.TimestampMillis == 0 || e.TimestampMillis > 9007199254740991 || !e.Reference.Complete(provider) || (e.ItemID != "" && !ID(e.ItemID)) || e.CompletedSteps > e.PlanSteps || e.PlanSteps > 128 {
		return false
	}
	if e.Kind != ProviderTerminal && e.ReportedLifecycle != "" || e.Kind == ProviderTerminal && e.ReportedLifecycle != Completed && e.ReportedLifecycle != Failed && e.ReportedLifecycle != Interrupted {
		return false
	}
	if e.HasExitCode && (e.Kind != ToolFinished || e.Source != ToolReceiptEvidence || e.ExitCode < 0 || e.ExitCode > 255) || !e.HasExitCode && e.ExitCode != 0 {
		return false
	}
	switch e.Kind {
	case ProviderStarted, ProviderTerminal:
		return e.Source == RuntimeEvidence && e.ItemID == "" && !e.HasExitCode && e.PlanSteps == 0
	case ToolStarted:
		return e.Source == RuntimeEvidence && e.ItemID != "" && !e.HasExitCode && e.PlanSteps == 0
	case ToolFinished:
		return (e.Source == RuntimeEvidence || e.Source == ToolReceiptEvidence && e.HasExitCode) && e.ItemID != "" && e.PlanSteps == 0
	case ModelClaim:
		return e.Source == AdvisoryEvidence && e.ItemID != "" && !e.HasExitCode && e.PlanSteps == 0
	case CheckpointReady:
		return e.Source == AdvisoryEvidence && e.ItemID != "" && !e.HasExitCode
	}
	return false
}

type EventLog struct {
	StreamID                             string
	Generation, LastSource, LastSequence uint64
	SourceGap                            bool
	Events                               []ExecutionEvent
}

func (l EventLog) Valid(run, dispatch string, provider Provider, ref Reference) bool {
	if len(l.Events) == 0 {
		return l.StreamID == "" && l.Generation == 0 && l.LastSource == 0 && l.LastSequence == 0 && !l.SourceGap
	}
	if !ID(l.StreamID) || l.Generation == 0 || l.LastSource == 0 || l.LastSequence < uint64(len(l.Events)) || len(l.Events) > EventCapacity {
		return false
	}
	type key struct {
		Stream     string
		Generation uint64
		ID         string
	}
	seen := map[key]bool{}
	for n, e := range l.Events {
		id := key{e.StreamID, e.Generation, e.EventID}
		if !e.Valid(provider) || e.RunID != run || e.DispatchID != dispatch || e.Reference != ref || e.Sequence != l.LastSequence-uint64(len(l.Events))+uint64(n)+1 || e.Generation > l.Generation || e.StreamID != l.StreamID || n > 0 && (e.Generation < l.Events[n-1].Generation || e.Generation == l.Events[n-1].Generation && e.SourceSequence <= l.Events[n-1].SourceSequence) || seen[id] {
			return false
		}
		seen[id] = true
	}
	last := l.Events[len(l.Events)-1]
	return last.StreamID == l.StreamID && last.Generation == l.Generation && last.SourceSequence <= l.LastSource
}
func (l EventLog) Append(e ExecutionEvent, provider Provider) (EventLog, error) {
	if e.Sequence != 0 || !e.Valid(provider) {
		return l, ErrInvalid
	}
	if !l.Valid(e.RunID, e.DispatchID, provider, e.Reference) {
		return l, ErrIdentity
	}
	for _, old := range l.Events {
		if old.StreamID == e.StreamID && old.Generation == e.Generation && old.EventID == e.EventID {
			equal := old
			equal.Sequence = 0
			equal.TimestampMillis = e.TimestampMillis
			equal.SourceSequence = e.SourceSequence
			if equal != e {
				return l, ErrConflict
			}
			if e.SourceSequence > l.LastSource && e.Generation == l.Generation {
				out := l
				out.LastSource = e.SourceSequence
				if e.SourceSequence != l.LastSource+1 {
					out.SourceGap = true
				}
				return out, nil
			}
			return l, nil
		}
	}
	if l.LastSequence >= 9007199254740991 {
		return l, ErrUnavailable
	}
	if l.Generation != 0 && (e.StreamID != l.StreamID || e.Generation < l.Generation || e.Generation == l.Generation && e.SourceSequence <= l.LastSource) {
		return l, ErrState
	}
	out := l
	out.Events = append([]ExecutionEvent(nil), l.Events...)
	expected := uint64(1)
	if l.Generation == e.Generation {
		expected = l.LastSource + 1
	} else if l.Generation != 0 {
		out.SourceGap = true
	}
	if e.SourceSequence != expected {
		out.SourceGap = true
	}
	e.Sequence = l.LastSequence + 1
	out.StreamID, out.Generation, out.LastSource, out.LastSequence = e.StreamID, e.Generation, e.SourceSequence, e.Sequence
	out.Events = append(out.Events, e)
	if len(out.Events) > EventCapacity {
		out.Events = out.Events[len(out.Events)-EventCapacity:]
	}
	return out, nil
}

type EventCursor struct {
	StreamID             string
	Generation, Sequence uint64
}
type EventPage struct {
	Events    []ExecutionEvent
	Next      EventCursor
	Gap, More bool
}

func (l EventLog) Page(cursor EventCursor, limit int) (EventPage, error) {
	if limit < 1 || limit > EventPageLimit {
		return EventPage{}, ErrInvalid
	}
	page := EventPage{Next: EventCursor{l.StreamID, l.Generation, cursor.Sequence}}
	if cursor.StreamID != "" && (cursor.StreamID != l.StreamID || cursor.Generation != l.Generation) {
		page.Gap = true
		page.Next.Sequence = l.LastSequence
		return page, nil
	}
	if cursor.Sequence > l.LastSequence || cursor.StreamID == "" && (cursor.Generation != 0 || cursor.Sequence != 0) {
		return EventPage{}, ErrInvalid
	}
	if len(l.Events) > 0 && cursor.Sequence < l.Events[0].Sequence-1 {
		page.Gap = true
	}
	for _, e := range l.Events {
		if e.Sequence > cursor.Sequence {
			if len(page.Events) == limit {
				page.More = true
				break
			}
			page.Events = append(page.Events, e)
			page.Next.Sequence = e.Sequence
		}
	}
	return page, nil
}

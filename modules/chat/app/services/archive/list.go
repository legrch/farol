package archive

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Summary is an immutable observation DTO. It deliberately has no publication,
// acknowledgement, live binding, provider capability or completed-result flag.
type Summary struct {
	Key, BackendGeneration, OperationID, ResultID, ConversationID string
	RecordedOutcome                                               string
	Bytes                                                         int
	Digest                                                        [32]byte
}

type ListQuery struct{ After string }
type ListResult struct {
	Observation string
	Entries     []Summary
	Next        string
	Unresolved  bool
}

func (s *Service) List(ctx context.Context, query ListQuery) (*ListResult, error) {
	if query.After != "" && !key(query.After) {
		return nil, Invalid
	}
	lease, scope, err := s.admit(ctx)
	if err != nil {
		return nil, err
	}
	page, err := s.deps.Store.ListStoredReplies(ctx, port.ArchiveListSelection{ProfileID: scope.ProfileID, OwnerID: scope.OwnerID, After: query.After})
	if err != nil {
		return nil, Unavailable
	}
	if recheck(ctx, lease, scope) != nil {
		return nil, Refused
	}
	if page == nil || page.Entries == nil || len(page.Entries) > port.ArchivePageSize || page.Next != "" && (len(page.Entries) != port.ArchivePageSize || page.Next != page.Entries[len(page.Entries)-1].Key) {
		return nil, Refused
	}
	out := &ListResult{Observation: Observation, Entries: make([]Summary, 0, len(page.Entries)), Next: page.Next, Unresolved: page.Unresolved}
	previous := query.After
	for _, v := range page.Entries {
		if !validSummary(v) || v.ProfileID != scope.ProfileID || v.OwnerID != scope.OwnerID || v.Key <= previous {
			return nil, Refused
		}
		previous = v.Key
		out.Entries = append(out.Entries, summarize(v))
	}
	if recheck(ctx, lease, scope) != nil {
		return nil, Refused
	}
	return out, nil
}

func summarize(v port.ArchiveSummary) Summary {
	return Summary{Key: v.Key, BackendGeneration: v.BackendGeneration, OperationID: v.OperationID, ResultID: v.ResultID, ConversationID: v.ConversationID, RecordedOutcome: v.RecordedOutcome, Bytes: v.Bytes, Digest: v.Digest}
}

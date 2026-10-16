package archive

import (
	"context"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type ReadQuery struct {
	Key    string
	Digest [32]byte
}
type ReadResult struct {
	Observation string
	Summary     Summary
	Text        string
}

func (s *Service) Read(ctx context.Context, query ReadQuery) (*ReadResult, error) {
	if !key(query.Key) || query.Digest == ([32]byte{}) {
		return nil, Invalid
	}
	lease, scope, err := s.admit(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := s.deps.Store.ReadStoredReply(ctx, port.ArchiveReadSelection{ProfileID: scope.ProfileID, OwnerID: scope.OwnerID, Key: query.Key, Digest: query.Digest})
	if err != nil {
		return nil, Unavailable
	}
	if recheck(ctx, lease, scope) != nil {
		return nil, Refused
	}
	if reply == nil || !validSummary(reply.Summary) || reply.Summary.ProfileID != scope.ProfileID || reply.Summary.OwnerID != scope.OwnerID || reply.Summary.Key != query.Key || reply.Summary.Digest != query.Digest || !utf8.ValidString(reply.Text) || len(reply.Text) != reply.Summary.Bytes {
		return nil, Refused
	}
	out := &ReadResult{Observation: Observation, Summary: summarize(reply.Summary), Text: reply.Text}
	if recheck(ctx, lease, scope) != nil {
		return nil, Refused
	}
	return out, nil
}

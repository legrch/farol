package boot

import (
	"context"

	wire "github.com/legrch/farol/gen/desktop/v1"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

// parsePublishedCodexRead joins explicit read metadata to a parsed Task source.
// IDs are exact ASCII values; there is no normalization or inferred latest turn.
func (s *ComputerIngress) parsePublishedCodexRead(in *wire.TaskCodexReadSelection, currentTask *codexclient.AuthoritySnapshot) (*wire.TaskCodexReadSelection, error) {
	if in == nil {
		return nil, nil
	}
	if currentTask == nil || !validPublishedCodexReadID(in.ThreadId) || !validPublishedCodexReadID(in.TurnId) {
		return nil, task.ErrUnavailable
	}
	copy := *in
	return &copy, nil
}

func validPublishedCodexReadID(id string) bool {
	if len(id) < 1 || len(id) > 120 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// currentCodexReadAuthority returns only the exact pair in the same guarded
// publication as the snapshot. This metadata does not prove native/provider
// membership or authority and activates no external read route.
func (s *ComputerIngress) currentCodexReadAuthority(ctx context.Context, hostID, scratch string) (codexclient.AuthoritySnapshot, controlct.Reference, error) {
	a, read, err := s.currentCodexPublication(ctx, hostID, scratch)
	if err != nil {
		return codexclient.AuthoritySnapshot{}, controlct.Reference{}, err
	}
	if read == nil {
		return codexclient.AuthoritySnapshot{}, controlct.Reference{}, task.ErrUnavailable
	}
	return a, controlct.Reference{ThreadID: read.ThreadId, TurnID: read.TurnId}, nil
}

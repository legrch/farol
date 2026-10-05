package workspace

import (
	"context"
	"errors"

	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Search is an in-process owning contract. The external MCP/wire route belongs
// to Lead; these correlation values cannot select or mint an execution lease.
type SearchRequest struct {
	OwnerID, SessionID, TaskID                 string
	TaskEpoch                                  uint64
	ParticipantID, TurnID                      string
	Generation                                 uint64
	CallID, WorkspaceID, RelativePath, Pattern string
}
type SearchMatch struct {
	Path      string
	Line      uint64
	Text      string
	Truncated bool
}
type SearchResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Matches                           []SearchMatch
	ResultLimited, ScanLimited        bool
}

func (c *Contract) Search(ctx context.Context, request SearchRequest) (*SearchResponse, error) {
	out, err := c.service.Search(ctx, workspacesvc.SearchRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath, Pattern: request.Pattern})
	if err != nil {
		// Search adds the active helper's timeout classification without
		// widening the shared Read/List error allowlist.
		var classified *authority.Failure
		if errors.As(err, &classified) && classified.Code == "WORKSPACE_SEARCH_TIMEOUT" && classified.Source == "native-workspace" {
			return nil, &Failure{Code: classified.Code, Source: classified.Source, Retry: "never"}
		}
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	matches := make([]SearchMatch, len(out.Matches))
	for i, m := range out.Matches {
		matches[i] = SearchMatch{Path: m.Path, Line: m.Line, Text: m.Text, Truncated: m.Truncated}
	}
	return &SearchResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch, ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath, Matches: matches, ResultLimited: out.ResultLimited, ScanLimited: out.ScanLimited}, nil
}

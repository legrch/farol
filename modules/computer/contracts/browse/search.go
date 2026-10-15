package browse

import (
	"context"

	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type SearchRequest struct{ WorkspaceID, RelativePath, Pattern string }
type SearchMatch struct {
	Path      string
	Line      uint64
	Text      string
	Truncated bool
}
type SearchResponse struct {
	WorkspaceID, RelativePath, Pattern string
	Root                               Root
	Matches                            []SearchMatch
	ResultLimited, ScanLimited         bool
}

// Search publishes only the current owner's bounded search projection. It
// creates no task, participant, grant or alternate filesystem implementation.
func (c *Contract) Search(ctx context.Context, request SearchRequest) (*SearchResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
	}
	out, err := c.service.Search(ctx, app.SearchQuery{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath, Pattern: request.Pattern})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	matches := make([]SearchMatch, len(out.Matches))
	for i, match := range out.Matches {
		matches[i] = SearchMatch{Path: match.Path, Line: match.Line, Text: match.Text, Truncated: match.Truncated}
	}
	return &SearchResponse{WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath, Pattern: out.Pattern,
		Root: Root{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode}, Matches: matches,
		ResultLimited: out.ResultLimited, ScanLimited: out.ScanLimited}, nil
}

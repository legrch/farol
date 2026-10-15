package browse

import (
	"context"
	"slices"

	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type ListRequest struct{ WorkspaceID, RelativePath string }
type ListResponse struct {
	WorkspaceID, RelativePath string
	Root                      Root
	Entries                   []string
	Truncated                 bool
}

func (c *Contract) List(ctx context.Context, request ListRequest) (*ListResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
	}
	out, err := c.service.List(ctx, app.ListQuery{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &ListResponse{WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath,
		Root:    Root{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode},
		Entries: slices.Clone(out.Entries), Truncated: out.Truncated}, nil
}

package browse

import (
	"context"

	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type SnapshotRequest struct{ WorkspaceID, RelativePath string }

// SnapshotResponse contains only metadata, with independent contract value types.
type SnapshotResponse struct {
	WorkspaceID, RelativePath string
	Root                      Root
	Bytes                     uint64
	SHA256                    string
}

func (c *Contract) Snapshot(ctx context.Context, request SnapshotRequest) (*SnapshotResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
	}
	out, err := c.service.Snapshot(ctx, app.SnapshotQuery{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &SnapshotResponse{WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath,
		Root:  Root{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode},
		Bytes: out.Bytes, SHA256: out.SHA256}, nil
}

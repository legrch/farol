package settingsworkspace

import (
	"context"

	app "github.com/legrch/farol/modules/computer/app/services/settingsworkspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// SnapshotResult contains only metadata, with independent contract value types.
type SnapshotResult struct {
	WorkspaceID, RelativePath string
	Root                      Root
	Bytes                     uint64
	SHA256                    string
}

func (c *Contract) Snapshot(ctx context.Context, request Request) (*SnapshotResult, error) {
	if c == nil || c.service == nil {
		return nil, failure(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
	}
	out, err := c.service.Snapshot(ctx, app.Request{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &SnapshotResult{WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath,
		Root:  Root{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode},
		Bytes: out.Bytes, SHA256: out.SHA256}, nil
}

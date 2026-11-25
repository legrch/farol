package browse

import (
	"context"

	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type InspectRequest struct{ WorkspaceID, RelativePath string }
type InspectResponse struct {
	WorkspaceID, RelativePath string
	Root                      Root
	// WritableByOthers marks a root that other local users can write to.
	WritableByOthers bool
}

// WritableFlag is the wire form of WritableByOthers: nil unless true, so an
// absent field means "no warning". Safe on a nil receiver.
func (r *InspectResponse) WritableFlag() *bool {
	if r == nil || !r.WritableByOthers {
		return nil
	}
	writable := true
	return &writable
}

func (c *Contract) Inspect(ctx context.Context, request InspectRequest) (*InspectResponse, error) {
	if c == nil || c.service == nil {
		return nil, failure(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
	}
	out, err := c.service.Inspect(ctx, app.ListQuery{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &InspectResponse{WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath,
		Root: Root{Path: out.Root.Path, Device: out.Root.Device, Inode: out.Root.Inode}, WritableByOthers: out.WritableByOthers}, nil
}

package workspace

import (
	"context"

	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
)

// Context is an owning in-process contract. Core owns any future wire mapping;
// no roots or approvals are admitted from these correlation fields.
type ContextRequest struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
}
type Root struct{ Path, Device, Inode string }
type ContextResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Root                              string
	ApprovedRoot                      Root
	Scope                             string
}

func (c *Contract) Context(ctx context.Context, request ContextRequest) (*ContextResponse, error) {
	out, err := c.service.Context(ctx, workspacesvc.ContextRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch,
		ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	return &ContextResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch, ParticipantID: out.ParticipantID, TurnID: out.TurnID,
		Generation: out.Generation, CallID: out.CallID, WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath, Root: out.Root,
		ApprovedRoot: Root{Path: out.ApprovedRoot.Path, Device: out.ApprovedRoot.Device, Inode: out.ApprovedRoot.Inode}, Scope: out.Scope}, nil
}

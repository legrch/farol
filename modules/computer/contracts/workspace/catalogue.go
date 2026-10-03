package workspace

import (
	"context"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
)

type CatalogueRequest struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
	Generation                 uint64
	CallID                     string
}
type CatalogueEntry struct {
	WorkspaceID, Root string
	ApprovedRoot      Root
}
type CatalogueResponse struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
	Generation                 uint64
	CallID                     string
	Workspaces                 []CatalogueEntry
	Consistency, Next          string
}

func (c *Contract) Catalogue(ctx context.Context, request CatalogueRequest) (*CatalogueResponse, error) {
	out, err := c.service.Catalogue(ctx, workspacesvc.CatalogueRequest{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID})
	if err != nil {
		return nil, failure(err)
	}
	if out == nil {
		return nil, failure(nil)
	}
	entries := make([]CatalogueEntry, 0, len(out.Workspaces))
	for _, entry := range out.Workspaces {
		entries = append(entries, CatalogueEntry{WorkspaceID: entry.WorkspaceID, Root: entry.Root, ApprovedRoot: Root{Path: entry.ApprovedRoot.Path, Device: entry.ApprovedRoot.Device, Inode: entry.ApprovedRoot.Inode}})
	}
	return &CatalogueResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch, ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, Workspaces: entries, Consistency: out.Consistency, Next: out.Next}, nil
}

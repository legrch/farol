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

// CatalogueRefusal explains why one workspace has no verified root. Its fields
// are the same allowlisted, path-free code/source/stage/reason as read failures.
type CatalogueRefusal struct{ Code, Source, Stage, Reason string }

// CatalogueEntry is either verified (Refusal nil) or refused (Refusal set, root
// fields are the unverified grant and approval records). WritableByOthers marks
// a verified root that group or other users can write to.
type CatalogueEntry struct {
	WorkspaceID, Root string
	ApprovedRoot      Root
	WritableByOthers  bool
	Refusal           *CatalogueRefusal
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
		mapped := CatalogueEntry{WorkspaceID: entry.WorkspaceID, Root: entry.Root, ApprovedRoot: Root{Path: entry.ApprovedRoot.Path, Device: entry.ApprovedRoot.Device, Inode: entry.ApprovedRoot.Inode}, WritableByOthers: entry.WritableByOthers}
		if entry.Refusal.Refused() {
			mapped.Refusal = catalogueRefusal(entry.Refusal)
		}
		entries = append(entries, mapped)
	}
	return &CatalogueResponse{OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch, ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, Workspaces: entries, Consistency: out.Consistency, Next: out.Next}, nil
}

// Match reports whether workspaceID is listed and usable. A listed entry that
// carries a refusal is not a match and yields the refusal's code; a missing
// workspace yields fallback. Safe on a nil receiver.
func (r *CatalogueResponse) Match(workspaceID, fallback string) (bool, string) {
	if r == nil {
		return false, fallback
	}
	for _, entry := range r.Workspaces {
		if entry.WorkspaceID != workspaceID {
			continue
		}
		if entry.Refusal != nil {
			return false, entry.Refusal.Code
		}
		return true, fallback
	}
	return false, fallback
}

// catalogueRefusal re-allowlists the code, source and the stage/reason pair at
// the module boundary. An unknown code or source degrades to the opaque helper
// failure; an unsafe pair is dropped, as for read failures.
func catalogueRefusal(in workspacesvc.CatalogueRefusal) *CatalogueRefusal {
	if !codes[in.Code] || !sources[in.Source] {
		return &CatalogueRefusal{Code: "WORKSPACE_HELPER_FAILED", Source: "native-workspace"}
	}
	out := &CatalogueRefusal{Code: in.Code, Source: in.Source}
	if in.Code == "WORKSPACE_PATH_REFUSED" && in.Source == "native-workspace" && SafePathReason(in.Stage, in.Reason) {
		out.Stage, out.Reason = in.Stage, in.Reason
	}
	return out
}

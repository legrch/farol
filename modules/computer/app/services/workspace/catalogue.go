package workspace

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
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

// Catalogue obtains candidates only from the selected participant's sealed
// subtree scopes. Each native context is checked in two complete ordered passes.
func (s *Service) Catalogue(ctx context.Context, request CatalogueRequest) (*CatalogueResponse, error) {
	binding := correlation{TaskBinding: port.TaskBinding{Identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, ParticipantID: request.ParticipantID, TurnID: request.TurnID}, generation: request.Generation, callID: request.CallID}
	seal, err := s.captureDiscovery(ctx, binding)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, scope := range seal.participant.Grant.Workspaces {
		if scope.Mode != authority.Subtree {
			continue
		}
		id := scope.WorkspaceID
		if !validIdentifier(id, 120) || seen[id] {
			return nil, contractInvalid("COMPUTER_WORKSPACE_CATALOGUE_INVALID")
		}
		ids = append(ids, id)
		seen[id] = true
		if len(ids) > 32 {
			return nil, contractInvalid("COMPUTER_WORKSPACE_CATALOGUE_INVALID")
		}
	}
	entries := make([]CatalogueEntry, 0, len(ids))
	for pass := 0; pass < 2; pass++ {
		for index, id := range ids {
			out, err := s.Context(ctx, binding.contextRequest(id, "."))
			if err != nil {
				return nil, err
			}
			if !binding.validContext(out, id, ".") {
				return nil, contractInvalid("COMPUTER_CONTRACT_INVALID")
			}
			entry := CatalogueEntry{WorkspaceID: id, Root: out.Root, ApprovedRoot: out.ApprovedRoot}
			if pass == 0 {
				entries = append(entries, entry)
			} else if entries[index] != entry {
				return nil, contractInvalid("COMPUTER_WORKSPACE_CONTEXT_CHANGED")
			}
		}
	}
	var response *CatalogueResponse
	err = s.discloseDiscovery(ctx, binding, seal, func() {
		response = &CatalogueResponse{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, Workspaces: entries,
			Consistency: "twice-checked current authority and physical roots; not an atomic filesystem snapshot",
			Next:        "Use the exact workspaceId with computer_workspace_bootstrap before working in that folder. Folder names and paths are not workspace IDs."}
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

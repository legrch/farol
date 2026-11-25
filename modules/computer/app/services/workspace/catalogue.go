package workspace

import (
	"context"
	"errors"

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

// CatalogueRefusal is the allowlisted, path-free reason one workspace could not
// be inspected. The zero value means the workspace was usable.
type CatalogueRefusal struct{ Code, Source, Stage, Reason string }

// Refused reports whether the entry carries a refusal instead of a verified root.
func (r CatalogueRefusal) Refused() bool { return r.Code != "" }

// CatalogueEntry is comparable so the two passes can be checked for equality.
// A refused entry keeps the grant's root and the approval's record for the same
// workspace (already disclosed for usable entries); neither was verified.
// WritableByOthers is meaningful only for a verified entry.
type CatalogueEntry struct {
	WorkspaceID, Root string
	ApprovedRoot      Root
	WritableByOthers  bool
	Refusal           CatalogueRefusal
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
// A workspace whose folder the native boundary refuses (policy, ownership,
// missing, unreadable) is reported on its own entry and no longer hides the
// usable ones; any other failure still discards the whole collection.
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
			var entry CatalogueEntry
			out, err := s.directoryContext(ctx, binding.contextRequest(id, "."), true, true)
			if err != nil {
				refused, ok := refusedEntry(seal, id, err)
				if !ok {
					return nil, err
				}
				entry = refused
			} else {
				if !binding.validContext(out, id, ".") {
					return nil, contractInvalid("COMPUTER_CONTRACT_INVALID")
				}
				entry = CatalogueEntry{WorkspaceID: id, Root: out.Root, ApprovedRoot: out.ApprovedRoot, WritableByOthers: out.WritableByOthers}
			}
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

// refusedEntry maps a per-workspace native refusal to its entry. Only refusals
// about this one folder qualify; authority, contract, cancellation, race and
// helper failures keep failing the whole call. The grant and approval sealed at
// the start supply the root, and the entry is dropped to the original error when
// they do not form a well-formed context.
func refusedEntry(seal discoverySeal, id string, err error) (CatalogueEntry, bool) {
	var failure *authority.Failure
	if !errors.As(err, &failure) || failure == nil || failure.Source != "native-workspace" {
		return CatalogueEntry{}, false
	}
	if failure.Code != "WORKSPACE_PATH_REFUSED" && failure.Code != "WORKSPACE_NOT_FOUND" {
		return CatalogueEntry{}, false
	}
	scope, found := authority.FindScope(seal.participant.Grant, id)
	if !found {
		return CatalogueEntry{}, false
	}
	approved, found := authority.FindApproved(seal.approval, id)
	if !found {
		return CatalogueEntry{}, false
	}
	record := Root{Path: approved.Root, Device: approved.RootIdentity.Device, Inode: approved.RootIdentity.Inode}
	if !validContextBinding(port.DirectoryBinding{RelativePath: ".", Root: scope.Root, ApprovedRoot: port.Root{Path: record.Path, Device: record.Device, Inode: record.Inode}}) {
		return CatalogueEntry{}, false
	}
	refusal := CatalogueRefusal{Code: failure.Code, Source: failure.Source}
	if failure.Code == "WORKSPACE_PATH_REFUSED" && authority.SafeWorkspaceReadDiagnostic(failure.Stage, failure.Reason) {
		refusal.Stage, refusal.Reason = failure.Stage, failure.Reason
	}
	return CatalogueEntry{WorkspaceID: id, Root: scope.Root, ApprovedRoot: record, Refusal: refusal}, true
}

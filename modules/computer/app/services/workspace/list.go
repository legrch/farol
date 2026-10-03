package workspace

import (
	"context"
	"slices"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type ListRequest struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
}
type ListResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Entries                           []string
	Truncated                         bool
}

func (s *Service) List(ctx context.Context, request ListRequest) (*ListResponse, error) {
	caller := caller{identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, participantID: request.ParticipantID, workspaceID: request.WorkspaceID, relativePath: request.RelativePath}
	admitted, err := s.admit(ctx, caller, authority.List)
	if err != nil {
		return nil, err
	}
	result, err := s.workspace.List(ctx, port.ListRequest{Workspace: cloneDescriptor(admitted.descriptor), RelativePath: request.RelativePath})
	if err != nil {
		return nil, nativeFailure(err)
	}
	if result == nil {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	var response *ListResponse
	err = s.disclose(ctx, caller, *admitted, func() {
		response = &ListResponse{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath, Entries: slices.Clone(result.Entries), Truncated: result.Truncated}
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

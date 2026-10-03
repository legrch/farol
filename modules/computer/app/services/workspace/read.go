package workspace

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Request types belong to this service, independently of native and wire DTOs.
type Range struct {
	Offset uint64
	Length uint32
}
type Page struct {
	Offset, Size uint64
	NextOffset   *uint64
}
type ReadRequest struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Range                             *Range
}
type ReadResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Text                              string
	Bytes                             uint64
	SHA256                            string
	Page                              *Page
}

func (s *Service) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	caller := caller{identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, participantID: request.ParticipantID, workspaceID: request.WorkspaceID, relativePath: request.RelativePath}
	admitted, err := s.admit(ctx, caller, authority.Read)
	if err != nil {
		return nil, err
	}
	native := port.ReadRequest{Workspace: cloneDescriptor(admitted.descriptor), RelativePath: request.RelativePath}
	if request.Range != nil {
		native.Range = &port.Range{Offset: request.Range.Offset, Length: request.Range.Length}
	}
	result, err := s.workspace.Read(ctx, native)
	if err != nil {
		return nil, nativeFailure(err)
	}
	if result == nil {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	var response *ReadResponse
	err = s.disclose(ctx, caller, *admitted, func() {
		response = &ReadResponse{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath, Text: result.Text, Bytes: result.Bytes, SHA256: result.SHA256}
		if result.Page != nil {
			response.Page = &Page{Offset: result.Page.Offset, Size: result.Page.Size}
			if result.Page.NextOffset != nil {
				next := *result.Page.NextOffset
				response.Page.NextOffset = &next
			}
		}
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

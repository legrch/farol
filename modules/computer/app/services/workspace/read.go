package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

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

// AuthorizeReadDiagnostic checks the current read grant without opening a file.
// The second snapshot rechecks revocation and descriptor changes before return.
func (s *Service) AuthorizeReadDiagnostic(ctx context.Context, request ReadRequest) (string, error) {
	if request.Range != nil {
		return "", authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	caller := caller{identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, participantID: request.ParticipantID, workspaceID: request.WorkspaceID, relativePath: request.RelativePath}
	admitted, err := s.admit(ctx, caller, authority.Read)
	if err != nil {
		return "", err
	}
	policy, ok := s.workspace.(port.ReadDiagnosticPolicy)
	if !ok {
		return "", authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	if err := policy.AuthorizeReadDiagnostic(ctx, port.ReadRequest{Workspace: cloneDescriptor(admitted.descriptor), RelativePath: request.RelativePath}); err != nil {
		return "", nativeFailure(err)
	}
	var binding string
	if err := s.disclose(ctx, caller, *admitted, func() { binding = readDiagnosticBinding(caller, *admitted) }); err != nil {
		return "", err
	}
	return binding, nil
}

func readDiagnosticBinding(c caller, a admission) string {
	value := struct {
		WorkspaceID, RelativePath, AuthorityID, ComputerID string
		Identity                                           authority.Identity
		ParticipantID                                      string
		ComputerGeneration                                 uint64
		Mode                                               authority.Mode
		Descriptor                                         port.Descriptor
	}{c.workspaceID, c.relativePath, a.authorityID, a.computerID, c.identity, c.participantID, a.computerGeneration, a.mode, a.descriptor}
	raw, _ := json.Marshal(value)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
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
		failure := nativeReadFailure(err)
		var classified *authority.Failure
		if errors.As(failure, &classified) && classified.Stage != "" {
			// A diagnostic is information about the target. Recheck the same
			// authority used for successful disclosure before returning it.
			if err := s.disclose(ctx, caller, *admitted, func() { classified.DiagnosticBinding = readDiagnosticBinding(caller, *admitted) }); err != nil {
				return nil, err
			}
		}
		return nil, failure
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

func nativeReadFailure(err error) error {
	out := nativeFailure(err).(*authority.Failure)
	var classified *authority.Failure
	if errors.As(err, &classified) && classified != nil && classified.Code == "WORKSPACE_PATH_REFUSED" && classified.Source == "native-workspace" && authority.SafeWorkspaceReadDiagnostic(classified.Stage, classified.Reason) {
		out.Stage, out.Reason = classified.Stage, classified.Reason
	}
	return out
}

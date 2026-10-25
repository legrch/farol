package workspace

import (
	"context"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Context uses list authority and checks one selected directory. It is not the
// recursive native list-context verb, a file inventory or an authority grant.
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

func (s *Service) Context(ctx context.Context, request ContextRequest) (*ContextResponse, error) {
	return s.directoryContext(ctx, request, false)
}

// Inspect checks directory access without enumerating children. It retains the
// same execution lease, descriptor binding and disclosure policy as Context.
func (s *Service) Inspect(ctx context.Context, request ContextRequest) (*ContextResponse, error) {
	return s.directoryContext(ctx, request, true)
}

func (s *Service) directoryContext(ctx context.Context, request ContextRequest, inspectOnly bool) (*ContextResponse, error) {
	caller := caller{identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, participantID: request.ParticipantID, workspaceID: request.WorkspaceID, relativePath: request.RelativePath}
	admitted, err := s.admit(ctx, caller, authority.List)
	if err != nil {
		return nil, err
	}
	query := port.ListRequest{Workspace: cloneDescriptor(admitted.descriptor), RelativePath: request.RelativePath}
	var checked *port.ListResponse
	if inspectOnly {
		inspector, ok := s.workspace.(port.DirectoryInspector)
		if !ok {
			return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
		}
		binding, failure := inspector.Inspect(ctx, query)
		err = failure
		checked = &port.ListResponse{Binding: binding}
	} else {
		checked, err = s.workspace.List(ctx, query)
	}
	if err != nil {
		return nil, nativeFailure(err)
	}
	if checked == nil || checked.Binding == nil {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	// Metadata copied from policy alone cannot produce a context. The native
	// boundary must return the binding it checked, under this exact descriptor.
	binding := *checked.Binding
	if !validContextBinding(binding) {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	if binding.RelativePath != request.RelativePath || binding.Root != admitted.descriptor.Root || binding.ApprovedRoot != admitted.descriptor.ApprovedRoot {
		return nil, authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")
	}
	var response *ContextResponse
	err = s.disclose(ctx, caller, *admitted, func() {
		response = &ContextResponse{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath,
			Root: binding.Root, ApprovedRoot: Root{Path: binding.ApprovedRoot.Path, Device: binding.ApprovedRoot.Device, Inode: binding.ApprovedRoot.Inode}, Scope: "subtree"}
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func validContextBinding(binding port.DirectoryBinding) bool {
	if binding.Root == "/" || binding.ApprovedRoot.Path == "/" || !authority.CanonicalPath(binding.Root) || !authority.CanonicalPath(binding.ApprovedRoot.Path) || !authority.Within(binding.ApprovedRoot.Path, binding.Root) {
		return false
	}
	if _, valid := absoluteTarget(binding.Root, binding.RelativePath); !valid {
		return false
	}
	for _, value := range []string{binding.ApprovedRoot.Device, binding.ApprovedRoot.Inode} {
		if len(value) == 0 || len(value) > 20 {
			return false
		}
		for _, r := range value {
			if r < '0' || r > '9' {
				return false
			}
		}
		if _, err := strconv.ParseUint(value, 10, 64); err != nil {
			return false
		}
	}
	return true
}

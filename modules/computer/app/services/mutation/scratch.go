package mutation

import (
	"context"
	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// CreateScratch shares the original owner's deadline, admission and publication
// gates. The only caller choice is an existing approved root. UUID fixes the
// unique leaf; no task/grant, arbitrary mkdir, deletion or recovery is created.
func (s *OwnerService) CreateScratch(ctx context.Context, workspaceID string) (*OwnerResponse, error) {
	if s == nil || s.engine == nil || !state.Identifier(workspaceID, 120) || !state.ScratchLeaf(state.ScratchPath(s.selected.OperationID)) {
		return nil, invalid()
	}
	path := state.ScratchPath(s.selected.OperationID)
	descriptor, err := s.engine.current(ctx, workspaceID, path, nil, nil)
	if err != nil {
		return nil, err
	}
	op := state.Scratch{Binding: state.ScratchBinding{RunID: s.selected.OperationID, Root: descriptor.Root, Leaf: path, RootIdentity: state.DirectoryIdentity{Device: descriptor.ApprovedRoot.Device, Inode: descriptor.ApprovedRoot.Inode}, ExpectedInventory: state.EmptyScratchInventory}}
	digest, err := s.engine.digester.Digest(port.MutationDigestInput{WorkspaceID: workspaceID, Operation: op})
	if err != nil || !state.SHA256(digest) {
		return nil, invalid()
	}
	binding := state.Binding{Identity: s.selected.identity(), WorkspaceID: workspaceID, ComputerGeneration: s.selected.ComputerGeneration, RelativePath: path, RequestDigest: digest, Scratch: op.Binding}
	out, err := s.engine.executeBound(ctx, binding, op)
	if err != nil {
		return nil, err
	}
	response := ownerResponse(s.selected, workspaceID, out)
	response.Scratch = binding.Scratch
	return response, nil
}

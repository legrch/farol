package boot

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// Both producers consume the policy captured by the existing application owner.
// No startup flag, MCP body, cached settings value or fallback selects authority.
type computerFileOwners struct {
	legacyRead, rootRead         port.Workspace
	legacyMutation, rootMutation port.MutableWorkspace
}

func newComputerFileOwners(home string) (*computerFileOwners, error) {
	legacyRead, err := filesystem.NewWithFilePolicy(home, authority.LegacyProtectedFiles)
	if err != nil {
		return nil, err
	}
	rootRead, err := filesystem.NewWithFilePolicy(home, authority.RootScopedFiles)
	if err != nil {
		return nil, err
	}
	legacyMutation, err := filesystem.NewMutableWithFilePolicy(home, authority.LegacyProtectedFiles)
	if err != nil {
		return nil, err
	}
	rootMutation, err := filesystem.NewMutableWithFilePolicy(home, authority.RootScopedFiles)
	if err != nil {
		return nil, err
	}
	return &computerFileOwners{legacyRead: legacyRead, rootRead: rootRead, legacyMutation: legacyMutation, rootMutation: rootMutation}, nil
}

func (o *computerFileOwners) reader(policy authority.FilePolicy) (port.Workspace, error) {
	if o == nil || !policy.Valid() {
		return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "file-policy")
	}
	selected := o.legacyRead
	if policy == authority.RootScopedFiles {
		selected = o.rootRead
	}
	if selected == nil {
		return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "file-policy")
	}
	return selected, nil
}

func (o *computerFileOwners) Read(ctx context.Context, request port.ReadRequest) (*port.ReadResponse, error) {
	selected, err := o.reader(request.Workspace.FilePolicy)
	if err != nil {
		return nil, err
	}
	return selected.Read(ctx, request)
}

func (o *computerFileOwners) List(ctx context.Context, request port.ListRequest) (*port.ListResponse, error) {
	selected, err := o.reader(request.Workspace.FilePolicy)
	if err != nil {
		return nil, err
	}
	return selected.List(ctx, request)
}

func (o *computerFileOwners) Mutate(ctx context.Context, request port.MutationRequest) (*port.MutationReceipt, error) {
	policy := request.Workspace.FilePolicy
	if o == nil || !policy.Valid() {
		return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "file-policy")
	}
	selected := o.legacyMutation
	if policy == authority.RootScopedFiles {
		selected = o.rootMutation
	}
	if selected == nil {
		return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "file-policy")
	}
	return selected.Mutate(ctx, request)
}

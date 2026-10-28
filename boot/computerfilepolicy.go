package boot

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"

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

var _ port.DirectoryInspector = (*computerFileOwners)(nil)

var _ port.Search = (*computerFileOwners)(nil)

func newComputerReaders(home string) (*computerFileOwners, error) {
	legacyRead, err := filesystem.NewWithFilePolicy(home, authority.LegacyProtectedFiles)
	if err != nil {
		return nil, err
	}
	rootRead, err := filesystem.NewWithFilePolicy(home, authority.RootScopedFiles)
	if err != nil {
		return nil, err
	}
	return &computerFileOwners{legacyRead: legacyRead, rootRead: rootRead}, nil
}

func newComputerFileOwners(home string, protected ...port.Root) (*computerFileOwners, error) {
	image, err := currentComputerImageRoot()
	if err != nil {
		return nil, err
	}
	return newComputerFileOwnersWithImage(home, image, protected...)
}

// The kernel executable, never a transport field or Shell setting, identifies
// the running image. Standalone backends protect their executable directory.
func currentComputerImageRoot() (port.Root, error) {
	executable, err := os.Executable()
	if err != nil {
		return port.Root{}, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return port.Root{}, err
	}
	image := filepath.Dir(executable)
	if filepath.Base(executable) == "farol-backend" && filepath.Base(image) == "app" && filepath.Base(filepath.Dir(image)) == "Resources" && filepath.Base(filepath.Dir(filepath.Dir(image))) == "Contents" {
		image = filepath.Dir(filepath.Dir(filepath.Dir(image)))
	}
	info, err := os.Stat(image)
	if err != nil {
		return port.Root{}, err
	}
	identity, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || image == string(filepath.Separator) {
		return port.Root{}, authority.Fail("WORKSPACE_PATH_REFUSED", "native-image")
	}
	return port.Root{Path: image, Device: strconv.FormatUint(uint64(identity.Dev), 10), Inode: strconv.FormatUint(uint64(identity.Ino), 10)}, nil
}

// protectedComputerRoot is denial-only metadata from the qualified profile owner.
// It does not grant access or replace the owner's lifetime checks.
func protectedComputerRoot(root NativeRoot) port.Root {
	return port.Root{Path: root.Path, Device: strconv.FormatUint(root.Device, 10), Inode: strconv.FormatUint(root.Inode, 10)}
}

func newComputerFileOwnersWithImage(home string, image port.Root, protected ...port.Root) (*computerFileOwners, error) {
	protected = append([]port.Root{image}, protected...)
	readers, err := newComputerReaders(home)
	if err != nil {
		return nil, err
	}
	legacyMutation, err := filesystem.NewMutableWithFilePolicy(home, authority.LegacyProtectedFiles, protected...)
	if err != nil {
		return nil, err
	}
	rootMutation, err := filesystem.NewMutableWithFilePolicy(home, authority.RootScopedFiles, protected...)
	if err != nil {
		return nil, err
	}
	readers.legacyMutation, readers.rootMutation = legacyMutation, rootMutation
	return readers, nil
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

func (o *computerFileOwners) Inspect(ctx context.Context, request port.ListRequest) (*port.DirectoryBinding, error) {
	selected, err := o.reader(request.Workspace.FilePolicy)
	if err != nil {
		return nil, err
	}
	inspector, ok := selected.(port.DirectoryInspector)
	if !ok {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	return inspector.Inspect(ctx, request)
}

func (o *computerFileOwners) Search(ctx context.Context, request port.SearchRequest) (*port.SearchResponse, error) {
	selected, err := o.reader(request.Workspace.FilePolicy)
	if err != nil {
		return nil, err
	}
	search, ok := selected.(port.Search)
	if !ok {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	return search.Search(ctx, request)
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

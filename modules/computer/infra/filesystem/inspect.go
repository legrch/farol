package filesystem

import (
	"context"
	"strings"

	"github.com/legrch/farol/modules/computer/app/port"
	"golang.org/x/sys/unix"
)

// Inspect verifies the selected directory through no-follow descriptors. Child
// churn does not change access. A replaced directory or root still refuses.
func (w *Workspace) Inspect(ctx context.Context, request port.ListRequest) (*port.DirectoryBinding, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	parts, err := components(request.RelativePath, false, true)
	if err != nil {
		return nil, err
	}
	policy, err := w.parsePolicy(request.Workspace)
	if err != nil {
		return nil, err
	}
	if policy.denies(parts) || policy.exact != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	root, binding, err := openedRoot(request.Workspace)
	if err != nil {
		return nil, err
	}
	defer unix.Close(root)
	rootInfo, err := stat(root)
	if err != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	selected, err := walk(root, parts)
	if err != nil {
		return nil, err
	}
	defer unix.Close(selected)
	before, err := stat(selected)
	if err != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if w.afterRead != nil {
		w.afterRead()
	}
	checked, err := walk(root, parts)
	if err != nil {
		return nil, err
	}
	defer unix.Close(checked)
	after, err := stat(checked)
	if err != nil || before.Dev != after.Dev || before.Ino != after.Ino || before.Mode != after.Mode {
		return nil, refusal("WORKSPACE_ROOT_CHANGED")
	}
	if err := recheckRoot(request.Workspace, rootInfo); err != nil {
		return nil, err
	}
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	binding.RelativePath = "."
	if len(parts) != 0 {
		binding.RelativePath = strings.Join(parts, "/")
	}
	return binding, nil
}

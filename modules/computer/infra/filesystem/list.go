package filesystem

import (
	"context"
	"golang.org/x/text/cases"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// List returns visible regular files and directories. Omitted names are not
// evidence of absence: denied paths, links and unsupported types are excluded.
func (w *Workspace) List(ctx context.Context, request port.ListRequest) (*port.ListResponse, error) {
	return w.list(ctx, request, nil)
}

func (w *Workspace) ListScratch(ctx context.Context, request port.ListRequest, binding port.ScratchReadBinding) (*port.ListResponse, error) {
	if !validScratchReadBinding(binding) || request.RelativePath != mutation.ScratchPath(binding.RunID) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	return w.list(ctx, request, &binding)
}

func (w *Workspace) list(ctx context.Context, request port.ListRequest, scratch *port.ScratchReadBinding) (*port.ListResponse, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	parts, err := components(request.RelativePath, false, true)
	if err != nil {
		return nil, err
	}
	p, err := w.parsePolicy(request.Workspace)
	if err != nil {
		return nil, err
	}
	if p.denies(parts) || p.exact != nil {
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
	fd, err := walk(root, parts)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "workspace-directory")
	defer file.Close()
	fixtureFD := -1
	if scratch != nil {
		fixtureFD, _, err = regular(fd, "check.txt")
		if err != nil {
			return nil, err
		}
		defer unix.Close(fixtureFD)
		if !scratchOpenedMatches(root, fd, fixtureFD, *scratch) {
			return nil, refusal("WORKSPACE_RACE_DETECTED")
		}
	}
	before, err := stat(fd)
	if err != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	names, overflow, err := boundedNames(ctx, file)
	if err != nil {
		return nil, err
	}
	if overflow {
		names = nil
	}
	folder := cases.Fold()
	sort.Slice(names, func(i, j int) bool {
		a, b := folder.String(names[i]), folder.String(names[j])
		if a == b {
			return names[i] < names[j]
		}
		return a < b
	})
	binding.RelativePath = "."
	if len(parts) != 0 {
		binding.RelativePath = strings.Join(parts, "/")
	}
	result := &port.ListResponse{Entries: make([]string, 0), Truncated: overflow, Binding: binding}
	for _, name := range names {
		if _, err := components(name, false, false); err != nil || strings.Contains(name, "/") {
			continue
		}
		target := append(append([]string{}, parts...), name)
		if p.denies(target) {
			continue
		}
		var child unix.Stat_t
		if err := unix.Fstatat(fd, name, &child, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return nil, refusal("WORKSPACE_RACE_DETECTED")
		}
		switch child.Mode & unix.S_IFMT {
		case unix.S_IFDIR:
			name += "/"
		case unix.S_IFREG:
			if child.Nlink != 1 {
				continue
			}
		default:
			continue
		}
		if len(result.Entries) == 500 {
			result.Truncated = true
			break
		}
		result.Entries = append(result.Entries, name)
	}
	if w.afterRead != nil {
		w.afterRead()
	}
	after, err := stat(fd)
	if err != nil || !stable(before, after) || scratch != nil && !scratchOpenedMatches(root, fd, fixtureFD, *scratch) {
		return nil, refusal("WORKSPACE_RACE_DETECTED")
	}
	if err := recheckRoot(request.Workspace, rootInfo); err != nil {
		return nil, err
	}
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

type nameReader interface{ Readdirnames(int) ([]string, error) }

func boundedNames(ctx context.Context, reader nameReader) ([]string, bool, error) {
	names := make([]string, 0)
	overflow := false
	for {
		if err := cancelled(ctx); err != nil {
			return nil, false, err
		}
		batch, err := reader.Readdirnames(1000)
		remaining := 100000 - len(names)
		if len(batch) > remaining {
			names = append(names, batch[:remaining]...)
			overflow = true
			break
		}
		names = append(names, batch...)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, false, refusal("WORKSPACE_PATH_REFUSED")
		}
	}
	if overflow {
		return nil, true, nil
	}
	return names, false, nil
}

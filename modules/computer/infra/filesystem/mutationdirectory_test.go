package filesystem

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// These tests use only the in-memory mutationFS model, not native filesystem evidence.
type directoryProbeFS struct {
	*fakeMutationFS
	probeErr error
}

func (f directoryProbeFS) lstat(parent int, name string) (fileVersion, error) {
	if f.probeErr != nil {
		return fileVersion{}, f.probeErr
	}
	return f.fakeMutationFS.lstat(parent, name)
}

func TestMutationDirectoryPureFailedOpenClassification(t *testing.T) {
	for _, tc := range []struct {
		name     string
		mode     uint32
		openErr  error
		probeErr error
		code     string
	}{
		{name: "symlink ENOTDIR", mode: unix.S_IFLNK | 0777, openErr: unix.ENOTDIR, code: "WORKSPACE_PATH_REFUSED"},
		{name: "symlink wrapped ENOTDIR", mode: unix.S_IFLNK | 0777, openErr: fmt.Errorf("open: %w", unix.ENOTDIR), code: "WORKSPACE_PATH_REFUSED"},
		{name: "symlink ELOOP", mode: unix.S_IFLNK | 0777, openErr: unix.ELOOP, code: "WORKSPACE_PATH_REFUSED"},
		{name: "missing", code: "WORKSPACE_NOT_FOUND"},
		{name: "regular file ENOTDIR", mode: unix.S_IFREG | 0644, code: "WORKSPACE_NOT_FOUND"},
		{name: "probe failed", openErr: unix.ENOTDIR, probeErr: unix.EACCES, code: "WORKSPACE_NOT_FOUND"},
		{name: "directory appeared after failed open", mode: unix.S_IFDIR | 0700, openErr: unix.ENOTDIR, code: "WORKSPACE_NOT_FOUND"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeMutationFS()
			if tc.mode != 0 {
				f.work.children["child"] = f.node(tc.mode)
			}
			opens := 0
			f.openFault = func(_ int, name string, flags int) error {
				opens++
				if name != "child" || flags != unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC {
					t.Fatalf("unexpected directory open: %q flags=%#x", name, flags)
				}
				return tc.openErr
			}
			parent := f.handle(f.work)
			defer f.close(parent)
			walk := mutationWalk{fs: directoryProbeFS{fakeMutationFS: f, probeErr: tc.probeErr}}
			defer walk.close()
			fd, err := walk.add(parent, "child")
			var failure *authority.Failure
			if !errors.As(err, &failure) || failure.Code != tc.code || failure.Retry != "never" {
				t.Fatalf("got %v; want %s/never", err, tc.code)
			}
			if fd != -1 || len(walk.pins) != 0 || len(f.handles) != 1 || opens != 1 {
				t.Fatalf("failed open accepted or retried: fd=%d pins=%d handles=%d opens=%d", fd, len(walk.pins), len(f.handles), opens)
			}
		})
	}
}

func TestMutationDirectoryPureSymlinkRefusalHasNoEffects(t *testing.T) {
	for _, root := range []bool{true, false} {
		t.Run(fmt.Sprintf("root=%t", root), func(t *testing.T) {
			m, f := fakeMutable()
			request := fakeRequest(mutation.Write{RelativePath: "alias/note.md", Content: "new"})
			name := "alias"
			if root {
				name = "work"
				f.rootNode.children[name] = f.node(unix.S_IFLNK | 0777)
			} else {
				f.work.children[name] = f.node(unix.S_IFLNK | 0777)
			}
			f.openFault = func(_ int, child string, _ int) error {
				if child == name {
					return unix.ENOTDIR
				}
				return nil
			}
			receipt, err := m.Mutate(context.Background(), request)
			var failure *authority.Failure
			if !errors.As(err, &failure) || failure.Code != "WORKSPACE_PATH_REFUSED" || failure.Retry != "never" {
				t.Fatalf("got %v; want WORKSPACE_PATH_REFUSED/never", err)
			}
			if receipt != nil || f.mkdirs != 0 || f.links != 0 || f.swaps != 0 || f.unlinks != 0 || len(f.handles) != 0 {
				t.Fatal("refused directory traversal had effects or leaked descriptors")
			}
		})
	}
}

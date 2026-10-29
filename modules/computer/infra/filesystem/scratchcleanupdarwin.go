//go:build darwin

package filesystem

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// RemoveEmptyScratch performs exactly one guarded removal. This private native
// primitive neither admits nor records an operation; the caller retains the
// original journal, whole-run fence and current owner throughout its use.
// A same-UID process outside those owners can race pathname checks on macOS.
func (m *Mutable) RemoveEmptyScratch(ctx context.Context, in port.ScratchCleanupRequest) (err error) {
	attempted := false
	defer func() {
		if err != nil && attempted {
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	}()
	b := in.Binding
	c := b.Creation
	if m == nil || m.fs == nil || ctx == nil || ctx.Err() != nil || !b.Valid() || in.Workspace.WorkspaceID != c.WorkspaceID || in.Workspace.Root != c.Scratch.Root || in.Workspace.ApprovedRoot.Path != c.Scratch.Root || in.Workspace.ApprovedRoot.Device != c.Scratch.RootIdentity.Device || in.Workspace.ApprovedRoot.Inode != c.Scratch.RootIdentity.Inode {
		return refusal("WORKSPACE_INVALID_REQUEST")
	}
	if err = m.policy(in.Workspace, c.RelativePath); err != nil {
		return err
	}
	request := port.MutationRequest{Workspace: in.Workspace, Operation: mutation.Scratch{Binding: c.Scratch}, BeforePublish: in.BeforePublish, WithPublication: in.WithPublication}
	walk, parent, err := m.root(in.Workspace)
	if err != nil {
		return err
	}
	closer, ok := walk.fs.(interface{ closeChecked(int) error })
	if !ok {
		walk.close()
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	defer func() {
		for i := len(walk.pins) - 1; i >= 0; i-- {
			err = errors.Join(err, closer.closeChecked(walk.pins[i].fd))
		}
	}()
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	fd, err := unix.Openat(parent, c.RelativePath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	defer func() {
		if closeErr := unix.Close(fd); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	var opened, named unix.Stat_t
	valid := func() bool {
		return unix.Fstat(fd, &opened) == nil && unix.Fstatat(parent, c.RelativePath, &named, unix.AT_SYMLINK_NOFOLLOW) == nil &&
			uint64(opened.Dev) == mustIdentity(b.Directory.Device) && opened.Ino == mustIdentity(b.Directory.Inode) && opened.Ino != 0 &&
			opened.Dev == named.Dev && opened.Ino == named.Ino && opened.Mode == named.Mode && opened.Uid == named.Uid &&
			opened.Mode&unix.S_IFMT == unix.S_IFDIR && opened.Mode&07777 == 0700 && opened.Uid == m.fs.uid()
	}
	if !valid() {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	duplicate, err := unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	inventory := os.NewFile(uintptr(duplicate), "scratch-cleanup-inventory")
	if inventory == nil {
		_ = unix.Close(duplicate)
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	entries, readErr := inventory.Readdirnames(1)
	closeErr := inventory.Close()
	if len(entries) != 0 || readErr != io.EOF || closeErr != nil {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	uncertain, err := withMutationPublication(ctx, request, walk, func() error {
		if !valid() {
			return refusal("WORKSPACE_MUTATION_CONFLICT")
		}
		attempted = true
		return unix.Unlinkat(parent, c.RelativePath, unix.AT_REMOVEDIR)
	})
	if uncertain || err != nil {
		return err
	}
	if err = m.fs.sync(parent); err != nil {
		return err
	}
	var after unix.Stat_t
	if ctx.Err() != nil || walk.check() != nil || !errors.Is(unix.Fstatat(parent, c.RelativePath, &after, unix.AT_SYMLINK_NOFOLLOW), unix.ENOENT) {
		return mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	return nil
}

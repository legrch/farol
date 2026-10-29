//go:build darwin

package filesystem

import (
	"context"
	"errors"
	"io"
	"os"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// RemoveScratchFile performs one file unlink followed by one empty-directory
// removal. The caller owns durable admission, custody, and process exclusion.
// A same-UID process outside those owners can race pathname checks on macOS.
func (m *Mutable) RemoveScratchFile(ctx context.Context, in port.ScratchFileCleanupRequest) (err error) {
	attempted := false
	defer func() {
		if err != nil && attempted {
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	}()
	i, b := in.Inventory, in.Inventory.Creation
	c := b.Creation
	if m == nil || m.fs == nil || ctx == nil || ctx.Err() != nil || !i.Valid() || in.DirectoryHold == nil || in.FileHold == nil || in.Workspace.WorkspaceID != c.WorkspaceID || in.Workspace.Root != c.Scratch.Root || in.Workspace.ApprovedRoot.Path != c.Scratch.Root || in.Workspace.ApprovedRoot.Device != c.Scratch.RootIdentity.Device || in.Workspace.ApprovedRoot.Inode != c.Scratch.RootIdentity.Inode {
		return refusal("WORKSPACE_INVALID_REQUEST")
	}
	if err = m.policy(in.Workspace, i.Mutation.RelativePath); err != nil {
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
		for n := len(walk.pins) - 1; n >= 0; n-- {
			err = errors.Join(err, closer.closeChecked(walk.pins[n].fd))
		}
	}()
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	dir, err := unix.Openat(parent, c.RelativePath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	defer func() { err = errors.Join(err, unix.Close(dir)) }()
	file, err := unix.Openat(dir, "check.txt", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	defer func() { err = errors.Join(err, unix.Close(file)) }()
	validDir := func() bool {
		var opened, named unix.Stat_t
		return in.DirectoryHold.Check(b.Directory) == nil && unix.Fstat(dir, &opened) == nil && unix.Fstatat(parent, c.RelativePath, &named, unix.AT_SYMLINK_NOFOLLOW) == nil &&
			uint64(opened.Dev) == mustIdentity(b.Directory.Device) && opened.Ino == mustIdentity(b.Directory.Inode) && opened.Ino != 0 &&
			opened.Dev == named.Dev && opened.Ino == named.Ino && opened.Mode == named.Mode && opened.Uid == named.Uid && opened.Mode&unix.S_IFMT == unix.S_IFDIR && opened.Mode&07777 == 0700 && opened.Uid == m.fs.uid()
	}
	version, err := m.fs.stat(file)
	if err != nil || !version.regular() || version.uid != m.fs.uid() || strconv.FormatUint(version.dev, 10) != i.File.Device || strconv.FormatUint(version.ino, 10) != i.File.Inode || version.size < 0 || version.size > mutation.MaxBytes {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	data, err := m.fs.read(file, mutation.MaxBytes)
	if err != nil || payloadHash(data) != i.SHA256 {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	validFile := func() bool {
		opened, e1 := m.fs.stat(file)
		named, e2 := m.fs.lstat(dir, "check.txt")
		return in.FileHold.Check(i.File) == nil && e1 == nil && e2 == nil && opened == version && named == version
	}
	directoryVersion, err := m.fs.stat(dir)
	if err != nil || !validDir() || !validFile() || !scratchInventoryHasOnly(dir, "check.txt") {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	afterInventory, err := m.fs.stat(dir)
	if err != nil || afterInventory != directoryVersion {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	uncertain, err := withMutationPublication(ctx, request, walk, func() error {
		currentDirectory, statErr := m.fs.stat(dir)
		if !validDir() || !validFile() || statErr != nil || currentDirectory != directoryVersion {
			return refusal("WORKSPACE_MUTATION_CONFLICT")
		}
		attempted = true
		return unix.Unlinkat(dir, "check.txt", 0)
	})
	if uncertain || err != nil {
		return err
	}
	if err = m.fs.sync(dir); err != nil {
		return err
	}
	if err = checkMutation(ctx, request, walk); err != nil {
		return err
	}
	if !scratchInventoryMatches(dir) {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	uncertain, err = withMutationPublication(ctx, request, walk, func() error {
		if !validDir() {
			return refusal("WORKSPACE_MUTATION_CONFLICT")
		}
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

func scratchInventoryHasOnly(fd int, name string) bool {
	copyFD, err := unix.Openat(fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	listing := os.NewFile(uintptr(copyFD), "scratch-file-inventory")
	if listing == nil {
		_ = unix.Close(copyFD)
		return false
	}
	entries, readErr := listing.Readdirnames(2)
	closeErr := listing.Close()
	return closeErr == nil && (readErr == nil || errors.Is(readErr, io.EOF)) && len(entries) == 1 && entries[0] == name
}

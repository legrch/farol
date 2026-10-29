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

// CreateStagedScratch publishes a single empty directory using a borrowed,
// separately qualified Computer descriptor. The caller owns that descriptor,
// the admitted operation, the stage gate, and terminal persistence. Private
// candidates and ambiguous outcomes are preserved; there is no retry or undo.
func (m *Mutable) CreateStagedScratch(ctx context.Context, r port.MutationRequest, stageFD int, stage port.Root) (receipt *port.MutationReceipt, err error) {
	op, ok := r.Operation.(mutation.Scratch)
	if m == nil || m.fs == nil || !ok || mutation.ValidateNative(op) != nil || stageFD < 0 || !mutation.Identifier(r.Workspace.WorkspaceID, 160) || op.Binding.Root != r.Workspace.Root || r.Workspace.Root != r.Workspace.ApprovedRoot.Path || op.Binding.RootIdentity != (mutation.DirectoryIdentity{Device: r.Workspace.ApprovedRoot.Device, Inode: r.Workspace.ApprovedRoot.Inode}) {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	if err = m.policy(r.Workspace, op.Path()); err != nil {
		return nil, err
	}
	walk, destination, err := m.root(r.Workspace)
	if err != nil {
		return nil, err
	}
	defer walk.close()
	if err = checkMutation(ctx, r, walk); err != nil {
		return nil, err
	}
	var stageStat unix.Stat_t
	if unix.Fstat(stageFD, &stageStat) != nil || uint64(stageStat.Dev) != mustIdentity(stage.Device) || stageStat.Ino != mustIdentity(stage.Inode) || stageStat.Ino == 0 || stageStat.Mode&unix.S_IFMT != unix.S_IFDIR || stageStat.Mode&07777 != 0700 || stageStat.Uid != m.fs.uid() {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	dstStat, err := m.fs.stat(destination)
	if err != nil || dstStat.dev != uint64(stageStat.Dev) {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if _, lookup := m.fs.lstat(destination, op.Path()); !errors.Is(lookup, unix.ENOENT) {
		return nil, refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	name, err := m.fs.name()
	if err != nil {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	if ctx.Err() != nil {
		return nil, refusal("WORKSPACE_MUTATION_CANCELLED")
	}
	// Once mkdir is attempted, an uncertain error or any later failure cannot
	// authorize another attempt or delete the possible candidate.
	attempted := true
	defer func() {
		if err != nil && attempted {
			err = mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
	}()
	if err = unix.Mkdirat(stageFD, name, 0700); err != nil {
		return nil, err
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	child, err := unix.Openat(stageFD, name, flags, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := unix.Close(child); closeErr != nil {
			err = errors.Join(err, closeErr)
		}
	}()
	var created, named unix.Stat_t
	if unix.Fstat(child, &created) != nil || created.Mode&unix.S_IFMT != unix.S_IFDIR || created.Mode&07777 != 0700 || created.Uid != m.fs.uid() || created.Ino == 0 || unix.Fstatat(stageFD, name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || created.Dev != named.Dev || created.Ino != named.Ino {
		return nil, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	receipt = &port.MutationReceipt{Operation: string(mutation.ScratchKind), RelativePath: op.Path(), Directory: mutation.DirectoryIdentity{Device: strconv.FormatUint(uint64(created.Dev), 10), Inode: strconv.FormatUint(created.Ino, 10)}}
	dup, err := unix.FcntlInt(uintptr(child), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return receipt, err
	}
	f := os.NewFile(uintptr(dup), "scratch-inventory")
	if f == nil {
		_ = unix.Close(dup)
		return receipt, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	entries, readErr := f.Readdirnames(1)
	closeErr := f.Close()
	if len(entries) != 0 || readErr != io.EOF || closeErr != nil {
		return receipt, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if err = unix.Fsync(child); err != nil {
		return receipt, err
	}
	if err = unix.Fsync(stageFD); err != nil {
		return receipt, err
	}
	if err = checkMutation(ctx, r, walk); err != nil {
		return receipt, err
	}
	uncertain, err := withMutationPublication(ctx, r, walk, func() error {
		var pinned, current unix.Stat_t
		if unix.Fstat(child, &pinned) != nil || unix.Fstatat(stageFD, name, &current, unix.AT_SYMLINK_NOFOLLOW) != nil || pinned.Dev != created.Dev || pinned.Ino != created.Ino || current.Dev != created.Dev || current.Ino != created.Ino || current.Mode != created.Mode || current.Uid != created.Uid {
			return mutationError("MUTATION_OUTCOME_UNKNOWN")
		}
		return unix.RenameatxNp(stageFD, name, destination, op.Path(), unix.RENAME_EXCL|unix.RENAME_NOFOLLOW_ANY)
	})
	if uncertain || err != nil {
		return receipt, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	var published unix.Stat_t
	if unix.Fstatat(destination, op.Path(), &published, unix.AT_SYMLINK_NOFOLLOW) != nil || published.Dev != created.Dev || published.Ino != created.Ino || published.Mode != created.Mode || published.Uid != created.Uid {
		return receipt, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if err = m.fs.sync(destination); err != nil {
		return receipt, err
	}
	if err = unix.Fsync(stageFD); err != nil {
		return receipt, err
	}
	var pinned unix.Stat_t
	if ctx.Err() != nil || walk.check() != nil || unix.Fstat(child, &pinned) != nil || unix.Fstatat(destination, op.Path(), &published, unix.AT_SYMLINK_NOFOLLOW) != nil || pinned.Dev != created.Dev || pinned.Ino != created.Ino || pinned.Mode != created.Mode || pinned.Uid != created.Uid || published.Dev != created.Dev || published.Ino != created.Ino || published.Mode != created.Mode || published.Uid != created.Uid {
		return receipt, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	return receipt, nil
}

func mustIdentity(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil || strconv.FormatUint(v, 10) != s {
		return 0
	}
	return v
}

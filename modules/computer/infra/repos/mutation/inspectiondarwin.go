//go:build darwin

package mutation

import (
	"context"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func inspectEmptyExisting(ctx context.Context, root Root) (result *EmptyInspection, err error) {
	d, err := openNativeMode(root, false)
	if err != nil {
		return nil, err
	}
	defer func() {
		if d.close() != nil {
			result, err = nil, unavailable()
		}
	}()
	initial := d.pins[len(d.pins)-1].initial
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, unavailable()
	}
	file := os.NewFile(uintptr(fd), "mutation-directory-inspection")
	// One entry is sufficient to refuse; never load an unbounded inventory or
	// follow/open a record, staging file, symlink, directory or FIFO.
	names, readErr := file.Readdirnames(1)
	closeErr := file.Close()
	if closeErr != nil || (readErr != nil && readErr != io.EOF) || ctx.Err() != nil {
		return nil, unavailable()
	}
	if len(names) != 0 {
		return nil, failure("COMPUTER_MUTATION_STORE_NOT_EMPTY")
	}
	after, err := stat(d.dir)
	afterLock, lockErr := stat(d.lock)
	if err != nil || lockErr != nil || !stable(initial, after) || !stable(d.lockIdentity, afterLock) || afterLock.Size != 0 || d.check() != nil || ctx.Err() != nil {
		return nil, unavailable()
	}
	return &EmptyInspection{Root: root, MutationsDevice: uint64(after.Dev), MutationsInode: after.Ino, LockDevice: uint64(d.lockIdentity.Dev), LockInode: d.lockIdentity.Ino}, nil
}

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

func withClosedEmptyInspection(ctx context.Context, root Root, visit func(EmptyInspection) error) (err error) {
	d, err := openNativeMode(root, false)
	if err != nil {
		return err
	}
	defer func() {
		if d.close() != nil || ctx.Err() != nil {
			err = unavailable()
		}
	}()
	if recheckClosedEmpty(d) != nil || ctx.Err() != nil {
		return unavailable()
	}
	// Run the complete final pass before releasing any pin or the lock. Do not
	// short-circuit this pass on a callback error or a cancelled context.
	defer func() {
		if recheckClosedEmpty(d) != nil || ctx.Err() != nil {
			err = unavailable()
		}
	}()
	initial := d.pins[len(d.pins)-1].initial
	return visit(EmptyInspection{Root: root, MutationsDevice: uint64(initial.Dev), MutationsInode: initial.Ino, LockDevice: uint64(d.lockIdentity.Dev), LockInode: d.lockIdentity.Ino})
}

func checkClosedEmptyIdentity(d *disk) error {
	if d.check() != nil {
		return unavailable()
	}
	// Ancestors retain their descriptor/name identity. The selected private
	// root, mutations directory and writer lock also retain their full versions.
	for _, p := range d.pins[len(d.pins)-2:] {
		current, err := stat(p.fd)
		var named unix.Stat_t
		if err != nil || !stable(p.initial, current) || unix.Fstatat(p.parent, p.name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(current, named) {
			return unavailable()
		}
	}
	current, err := stat(d.lock)
	var named unix.Stat_t
	root := d.pins[len(d.pins)-2].fd
	if err != nil || current.Size != 0 || !stable(d.lockIdentity, current) || unix.Fstatat(root, writerName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(current, named) {
		return unavailable()
	}
	return d.check()
}

func recheckClosedEmpty(d *disk) error {
	if checkClosedEmptyIdentity(d) != nil {
		return unavailable()
	}
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return unavailable()
	}
	file := os.NewFile(uintptr(fd), "closed-empty-mutation-inspection")
	// Each pass uses a fresh directory offset and reads at most one entry.
	// It never opens an entry, including unknown files, aliases and FIFOs.
	names, readErr := file.Readdirnames(1)
	closeErr := file.Close()
	identityErr := checkClosedEmptyIdentity(d)
	if closeErr != nil || identityErr != nil || readErr != io.EOF || len(names) != 0 {
		return unavailable()
	}
	return nil
}

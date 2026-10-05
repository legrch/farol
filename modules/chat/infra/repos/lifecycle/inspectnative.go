//go:build darwin || linux

package lifecycle

import (
	"bytes"
	"context"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func inspectClosedSnapshot(ctx context.Context, root Root, limits Limits) (*Inspection, error) {
	d, err := openInspectionDisk(ctx, root)
	if err != nil {
		return nil, err
	}
	inspection, err := inspectLockedSnapshot(ctx, d, limits)
	// Every path releases only our descriptors/lock. No sync, unlink or writer
	// close/retirement path is called. Read failures publish no uncertain bytes.
	if d.close() != nil {
		return nil, failure(Unavailable, false)
	}
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	return inspection, nil
}

// Do not call openClaim: even its existing-claim path fsyncs. The private disk
// value here is used only for its existing check/read/descriptor-close helpers;
// it never reaches an owner or a Repository.
func openInspectionDisk(ctx context.Context, root Root) (*disk, error) {
	if !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || root.Device == 0 || root.Inode == 0 || root.OwnerUID != uint32(os.Geteuid()) {
		return nil, failure(Invalid, false)
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return nil, failure(Refused, false)
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, failure(Refused, false)
	}
	d := &disk{root: root, dir: fd, claim: -1}
	fail := func(code Code) (*disk, error) {
		if d.close() != nil {
			code = Unavailable
		}
		return nil, failure(code, false)
	}
	d.dirIdentity, err = stat(fd)
	if err != nil || !physical(d.dirIdentity, unix.S_IFDIR, 0700, root.OwnerUID) || uint64(d.dirIdentity.Dev) != root.Device || uint64(d.dirIdentity.Ino) != root.Inode {
		return fail(Refused)
	}
	if ctx.Err() != nil {
		return fail(Cancelled)
	}
	d.claim, err = unix.Openat(fd, claimName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return fail(Refused)
	}
	d.claimIdentity, err = stat(d.claim)
	if err != nil || !physical(d.claimIdentity, unix.S_IFREG, 0600, root.OwnerUID) || unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB) != nil || d.check() != nil {
		return fail(Refused)
	}
	if ctx.Err() != nil {
		return fail(Cancelled)
	}
	return d, nil
}

func inspectLockedSnapshot(ctx context.Context, d *disk, limits Limits) (*Inspection, error) {
	var before, after unix.Stat_t
	if d.check() != nil || unix.Fstatat(d.dir, snapshotName, &before, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return nil, failure(Unavailable, false)
	}
	raw, err := d.read(limits.Bytes)
	if err != nil {
		return nil, failure(Unavailable, false)
	}
	if ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	inspection, err := inspectRecord(raw, d.root, limits)
	if err != nil {
		return nil, err
	}
	// A second bounded qualified read spans decoding/classification. Compare
	// identity/timestamps as well as bytes, including same-byte replacement or
	// mutation-and-restoration. Each read also qualifies the named entry and root.
	current, err := d.read(limits.Bytes)
	claim, statErr := stat(d.claim)
	if err != nil || statErr != nil || !stable(d.claimIdentity, claim) || !bytes.Equal(raw, current) || unix.Fstatat(d.dir, snapshotName, &after, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(before, after) || d.check() != nil {
		return nil, failure(Unavailable, false)
	}
	if ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	return inspection, nil
}

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
	if closed := d.close(); closed != nil {
		return nil, inspectionCleanupFailure(err, closed)
	}
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, inspectionFailure(&Failure{Code: Cancelled}, InspectionCancelled, err)
	}
	return inspection, nil
}

// Do not call openClaim: even its existing-claim path fsyncs. The private disk
// value here is used only for its existing check/read/descriptor-close helpers;
// it never reaches an owner or a Repository.
func openInspectionDisk(ctx context.Context, root Root) (*disk, error) {
	if !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || root.Device == 0 || root.Inode == 0 || root.OwnerUID != uint32(os.Geteuid()) {
		return nil, inspectionFailure(&Failure{Code: Invalid}, InspectionRootInvalid)
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return nil, inspectionFailure(&Failure{Code: Refused}, InspectionRootRoute, err)
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, inspectionFailure(&Failure{Code: Refused}, InspectionRootRoute, err)
	}
	d := &disk{root: root, dir: fd, claim: -1}
	fail := func(original *InspectionFailure) (*disk, error) {
		if closed := d.close(); closed != nil {
			return nil, inspectionCleanupFailure(original, closed)
		}
		return nil, original
	}
	d.dirIdentity, err = stat(fd)
	if err != nil || !physical(d.dirIdentity, unix.S_IFDIR, 0700, root.OwnerUID) {
		return fail(inspectionFailure(&Failure{Code: Refused}, InspectionRootMetadata, err))
	}
	if uint64(d.dirIdentity.Dev) != root.Device || uint64(d.dirIdentity.Ino) != root.Inode {
		return fail(inspectionFailure(&Failure{Code: Refused}, InspectionRootIdentity))
	}
	if err := ctx.Err(); err != nil {
		return fail(inspectionFailure(&Failure{Code: Cancelled}, InspectionCancelled, err))
	}
	d.claim, err = unix.Openat(fd, claimName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return fail(inspectionFailure(&Failure{Code: Refused}, InspectionClaimOpen, err))
	}
	d.claimIdentity, err = stat(d.claim)
	if err != nil || !physical(d.claimIdentity, unix.S_IFREG, 0600, root.OwnerUID) {
		return fail(inspectionFailure(&Failure{Code: Refused}, InspectionClaimMetadata, err))
	}
	if err := unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(inspectionFailure(&Failure{Code: Refused}, InspectionClaimLock, err))
	}
	if err := d.check(); err != nil {
		return fail(inspectionFailure(&Failure{Code: Refused}, InspectionClaimRoute, err))
	}
	if err := ctx.Err(); err != nil {
		return fail(inspectionFailure(&Failure{Code: Cancelled}, InspectionCancelled, err))
	}
	return d, nil
}

func inspectLockedSnapshot(ctx context.Context, d *disk, limits Limits) (*Inspection, error) {
	var before, after unix.Stat_t
	if err := d.check(); err != nil {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionClaimRoute, err)
	}
	if err := unix.Fstatat(d.dir, snapshotName, &before, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionSnapshotRead, err)
	}
	raw, err := d.read(limits.Bytes)
	if err != nil {
		// read already classifies some failures. Retain exactly what it returns,
		// without inventing syscall provenance or changing this refusal's code.
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionSnapshotRead, err)
	}
	if err := ctx.Err(); err != nil {
		return nil, inspectionFailure(&Failure{Code: Cancelled}, InspectionCancelled, err)
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
	// The original claim stat is unconditional even when the read fails. All
	// remaining predicates retain their original short-circuit order.
	if err != nil {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionSnapshotRead, err, statErr)
	}
	if statErr != nil || !stable(d.claimIdentity, claim) || !bytes.Equal(raw, current) {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionSnapshotChanged, statErr)
	}
	if err := unix.Fstatat(d.dir, snapshotName, &after, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionSnapshotChanged, err)
	}
	if !stable(before, after) {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionSnapshotChanged)
	}
	if err := d.check(); err != nil {
		return nil, inspectionFailure(&Failure{Code: Unavailable}, InspectionClaimRoute, err)
	}
	if err := ctx.Err(); err != nil {
		return nil, inspectionFailure(&Failure{Code: Cancelled}, InspectionCancelled, err)
	}
	return inspection, nil
}

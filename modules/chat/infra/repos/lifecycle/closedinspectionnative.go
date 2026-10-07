//go:build darwin || linux

package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

func withClosedInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits, inspect func(ClosedInspection) error) (err error) {
	d, err := openInspectionDisk(ctx, root)
	if err != nil {
		return err
	}
	defer func() {
		if d.close() != nil {
			err = failure(Unavailable, false)
		}
	}()
	// Preserve named snapshot identity across both classification and callback,
	// including replacements with identical bytes and in-place restoration.
	var before unix.Stat_t
	if unix.Fstatat(d.dir, snapshotName, &before, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return failure(Unavailable, false)
	}
	observed, err := inspectLockedSnapshot(ctx, d, limits)
	if err != nil {
		return err
	}
	value, err := closedInspectionMetadata(observed, scope)
	if err != nil {
		return err
	}
	recheck := func() error {
		current, err := inspectLockedSnapshot(ctx, d, limits)
		if err != nil {
			return err
		}
		var after unix.Stat_t
		claim, claimErr := stat(d.claim)
		if claimErr != nil || !stable(d.claimIdentity, claim) || unix.Fstatat(d.dir, snapshotName, &after, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(before, after) || current.SnapshotDigest != value.SnapshotDigest || d.check() != nil {
			return failure(Unavailable, false)
		}
		return nil
	}
	// Qualify the baseline before exposing even provisional metadata.
	if err := recheck(); err != nil {
		return err
	}
	return closedInspectionCallback(ctx, value, recheck, inspect)
}

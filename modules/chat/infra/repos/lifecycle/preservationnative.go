//go:build darwin || linux

package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

func acquirePreservationInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits) (_ *PreservationLease, result error) {
	d, err := openInspectionDisk(ctx, root)
	if err != nil {
		return nil, err
	}
	retained := false
	defer func() {
		if !retained && d.close() != nil {
			result = failure(Unavailable, false)
		}
	}()
	var before unix.Stat_t
	if unix.Fstatat(d.dir, snapshotName, &before, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return nil, failure(Unavailable, false)
	}
	observed, err := inspectLockedSnapshot(ctx, d, limits)
	if err != nil {
		return nil, err
	}
	if observed == nil || observed.Scope != scope {
		return nil, failure(Refused, false)
	}
	// The existing canonical decoder validates every stored transition and plan.
	// Keeping nonempty counts does not convert recorded terminal/unknown state
	// into current authority, origin proof or a recovered operation handle.
	value := copyPreservationInspection(*observed)
	recheck := func() error {
		if ctx.Err() != nil {
			return failure(Cancelled, false)
		}
		current, err := inspectLockedSnapshot(ctx, d, limits)
		if err != nil {
			return err
		}
		var after unix.Stat_t
		claim, claimErr := stat(d.claim)
		if claimErr != nil || !stable(d.claimIdentity, claim) || unix.Fstatat(d.dir, snapshotName, &after, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(before, after) || current.SnapshotDigest != value.SnapshotDigest || current.Scope != scope || d.check() != nil {
			return failure(Unavailable, false)
		}
		if ctx.Err() != nil {
			return failure(Cancelled, false)
		}
		return nil
	}
	if err := recheck(); err != nil {
		return nil, err
	}
	retained = true
	return &PreservationLease{lifetime: &ClosedLease{verify: recheck, close: d.close}, value: value, ctx: ctx}, nil
}

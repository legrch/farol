//go:build darwin || linux

package results

import (
	"context"
	"crypto/sha256"
	"encoding/json"

	"github.com/legrch/farol/modules/chat/app/port"
)

func withClosedInspection(ctx context.Context, root Root, scope port.JournalScope, inspect func(ClosedInspection) error) (err error) {
	// Fixed open mode in the existing helper never creates, syncs or poisons,
	// including failures. Do not call NewNative/newResultOwner: their scan can
	// poison on failed reads. Only the existing disk's read/check/close are used.
	d, err := openResultDisk(ctx, root, "open")
	if err != nil {
		return err
	}
	defer func() {
		if d.close() != nil {
			err = Unavailable
		}
	}()
	expected, err := json.Marshal(resultClaimRecord{1, root.ProfileID, root.Identity, d.identity()})
	if err != nil {
		return Invalid
	}
	raw, err := d.readFile(ctx, resultClaim, len(expected))
	if err != nil {
		return err
	}
	keys, err := d.inventory(ctx)
	if err != nil {
		return err
	}
	value, err := closedInspectionMetadata(root, scope, d.identity(), sha256.Sum256(raw), keys)
	if err != nil {
		return err
	}
	recheck := func() error {
		keys, err := d.inventory(ctx)
		if err != nil {
			return err
		}
		claim, err := d.readFile(ctx, resultClaim, len(expected))
		if err != nil {
			return err
		}
		parent, pe := resultStat(d.rootFD)
		child, ce := resultStat(d.dir)
		if len(keys) != 0 || sha256.Sum256(claim) != value.ClaimDigest || pe != nil || ce != nil || !resultStable(d.rootMeta, parent) || !resultStable(d.dirMeta, child) || d.check() != nil {
			return resultFailure(Refused, false)
		}
		return nil
	}
	if err := recheck(); err != nil {
		return err
	}
	return closedInspectionCallback(ctx, value, recheck, inspect)
}

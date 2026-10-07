package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// ClosedInspection is metadata for a canonical, currently empty journal with no
// recorded retirement. It is diagnostic data, never recovery, admission, clean
// retirement or permission to repeat an unknown operation. Incarnations includes
// only the recorded generation history, not an inventory of the profile.
type ClosedInspection struct {
	Scope          port.JournalScope
	Root           port.JournalRoot
	SnapshotDigest [32]byte
	Version        int
	Revision       uint64
	Incarnations   []string
}

// WithClosedInspection retains the EXISTING claim lock through inspect and the
// final recheck. It creates, writes, deletes and syncs nothing. Callers may nest
// results and handoff inspections inside inspect to retain all three claims.
// Callback metadata is provisional until this function returns nil, and conveys
// no ongoing lock after return. The callback must not mutate inspected storage.
// Limits cannot exceed the existing boot budget (1 MiB, 4096 records).
func WithClosedInspection(ctx context.Context, root Root, scope port.JournalScope, limits Limits, inspect func(ClosedInspection) error) error {
	if ctx == nil || ctx.Err() != nil {
		return failure(Cancelled, false)
	}
	if inspect == nil || !validID(root.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != root.ProfileID || !validLimits(limits) || limits.Bytes > 1024*1024 || limits.Records > 4096 {
		return failure(Invalid, false)
	}
	return withClosedInspection(ctx, root, scope, limits, inspect)
}

func closedInspectionMetadata(value *Inspection, scope port.JournalScope) (ClosedInspection, error) {
	if value == nil || value.Scope != scope || value.WriteCount != 0 || value.TurnCount != 0 || value.Retirement != nil {
		return ClosedInspection{}, failure(Refused, false)
	}
	return ClosedInspection{Scope: value.Scope, Root: value.Root, SnapshotDigest: value.SnapshotDigest,
		Version: value.Version, Incarnations: append([]string(nil), value.Incarnations...)}, nil
}

func closedInspectionCallback(ctx context.Context, value ClosedInspection, recheck func() error, inspect func(ClosedInspection) error) error {
	if ctx.Err() != nil {
		return failure(Cancelled, false)
	}
	value.Incarnations = append([]string(nil), value.Incarnations...)
	callbackErr := inspect(value)
	// Even a failed callback must recheck before releasing the claim. A changed
	// observation wins over the callback error; neither authorizes a retry.
	if err := recheck(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return failure(Cancelled, false)
	}
	return callbackErr
}

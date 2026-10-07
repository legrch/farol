package results

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// ClosedInspection describes an existing, strictly empty result namespace.
// Scope is the caller's current lifecycle scope, not persisted result authority.
// ClaimDigest identifies canonical profile/root/store claim bytes, never content.
// This metadata grants no recovery, result publication or admission authority.
type ClosedInspection struct {
	Scope             port.JournalScope
	Root, StorageRoot port.JournalRoot
	ClaimDigest       [32]byte
	ResultCount       int
}

// WithClosedInspection keeps the existing result claim locked through inspect
// and a final physical/claim/inventory recheck. Call inside the lifecycle callback
// to retain that claim too. It never constructs a result owner, reads result
// bodies, creates, writes, deletes, syncs or poisons storage. Metadata remains
// provisional until nil return; inspect must not mutate inspected storage.
func WithClosedInspection(ctx context.Context, root Root, scope port.JournalScope, inspect func(ClosedInspection) error) error {
	if nilContext(ctx) || ctx.Err() != nil || inspect == nil || !validID(root.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != root.ProfileID || root.Identity.Device == 0 || root.Identity.Inode == 0 {
		return Invalid
	}
	return withClosedInspection(ctx, root, scope, inspect)
}

func closedInspectionMetadata(root Root, scope port.JournalScope, storageRoot port.JournalRoot, digest [32]byte, keys []string) (ClosedInspection, error) {
	if !validID(root.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != root.ProfileID || !validRoots(root.Identity, storageRoot) || digest == ([32]byte{}) || len(keys) != 0 {
		return ClosedInspection{}, resultFailure(Refused, false)
	}
	return ClosedInspection{Scope: scope, Root: root.Identity, StorageRoot: storageRoot, ClaimDigest: digest}, nil
}

func closedInspectionCallback(ctx context.Context, value ClosedInspection, recheck func() error, inspect func(ClosedInspection) error) error {
	if ctx.Err() != nil {
		return Unavailable
	}
	callbackErr := inspect(value)
	if err := recheck(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Unavailable
	}
	return callbackErr
}

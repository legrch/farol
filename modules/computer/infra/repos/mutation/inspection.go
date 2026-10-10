package mutation

import "context"

// EmptyInspection describes only the observed mutation directory. It does not
// settle previous outcomes, retire its writer, or authorize a successor. The
// caller must separately own maintenance exclusion and qualify every other
// profile journal; a later effect requires fresh validation under that exclusion.
type EmptyInspection struct {
	Root                            Root
	MutationsDevice, MutationsInode uint64
	LockDevice, LockInode           uint64
}

// InspectEmpty opens an existing closed store without creating its writer lock.
// Any record, staging file or unknown entry refuses this narrow diagnostic.
// No stored operation is decoded, removed, replayed or reclassified.
func InspectEmpty(ctx context.Context, root Root) (*EmptyInspection, error) {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) {
		return nil, unavailable()
	}
	return inspectEmptyExisting(ctx, root)
}

// WithClosedEmptyInspection keeps the existing nonblocking writer lock and
// pinned path identities through one synchronous trusted visitor and a final
// empty-store recheck, including when the visitor returns an error or cancels
// ctx. It opens only existing state and passes values, never descriptors or
// writer/recovery authority. A failed recheck or cancellation takes precedence
// over the visitor's error; otherwise that error is returned unchanged.
//
// Cancellation cannot interrupt an arbitrary stuck visitor: no background
// visitor is launched and the lock stays held until it returns. This excludes
// cooperating writers only; namespace observations are not an atomic filesystem
// snapshot and cannot prevent hostile changes or effects already made by the
// visitor. The caller still owns maintenance exclusion and all other journals.
func WithClosedEmptyInspection(ctx context.Context, root Root, visit func(EmptyInspection) error) error {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) || visit == nil {
		return unavailable()
	}
	return withClosedEmptyInspection(ctx, root, visit)
}

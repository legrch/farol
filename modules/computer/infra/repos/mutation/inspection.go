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

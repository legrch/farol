//go:build darwin

package mutation

import "context"

func inspectOwnerExisting(ctx context.Context, root Root, expected []ExpectedOwnerRecord, visit func(OwnerInspection) error) (*OwnerInspection, error) {
	var result *OwnerInspection
	err := inspectBoundedNative(ctx, root, len(expected), func(o settledObservation) (err error) {
		result, err = observeOwnerCompleted(ctx, expected, o, visit)
		return err
	})
	if err != nil || ctx.Err() != nil {
		if err != nil {
			return nil, err
		}
		return nil, unavailable()
	}
	return result, nil
}

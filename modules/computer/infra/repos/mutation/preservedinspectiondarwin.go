//go:build darwin

package mutation

import "context"

func inspectPreservedExisting(ctx context.Context, root Root, expected []ExpectedPreservedRecord, visit func(PreservedInspection) error) (*PreservedInspection, error) {
	var result *PreservedInspection
	err := inspectBoundedNative(ctx, root, len(expected), func(o settledObservation) (err error) {
		result, err = observePreserved(ctx, expected, o, visit)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

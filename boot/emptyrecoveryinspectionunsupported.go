//go:build !darwin && !linux

package boot

import "context"

func inspectEmptyRecoveryNamespaces(context.Context, NativeRoot, NativeRoot, NativeRoot, int) error {
	return profileFailure(ProfileUnsupported)
}

func withEmptyRecoveryTask(context.Context, NativeRoot, func() error) error {
	return profileFailure(ProfileUnsupported)
}

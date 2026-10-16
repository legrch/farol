//go:build !darwin

package boot

import "context"

func inspectPreservedProfileNamespaces(context.Context, NativeRoot, NativeRoot, NativeRoot, int) error {
	return profileFailure(ProfileUnsupported)
}

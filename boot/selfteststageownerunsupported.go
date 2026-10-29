//go:build !darwin

package boot

func duplicateComputerDescriptor(*QualifiedProfile) (int, NativeRoot, error) {
	return -1, NativeRoot{}, profileFailure(ProfileUnsupported)
}
func closeStageDescriptor(int) error { return profileFailure(ProfileUnsupported) }

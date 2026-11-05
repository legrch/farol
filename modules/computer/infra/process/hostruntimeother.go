//go:build !darwin

package process

import "context"

func DiscoverInstalledHostRuntime(context.Context) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}
func DiscoverInstalledHostRuntimeForPath(context.Context, string) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}
func CaptureUserExecutablePath(context.Context) (string, error) {
	return "", errHostRuntime
}

func (nativePlatformFacts) hostRuntime(context.Context, *HostRuntimePlan) error {
	return errHostRuntime
}

//go:build !darwin

package process

import "context"

type UserExecutableEnvironment struct {
	Path, Home, User, Shell, XDGConfigHome, DeveloperDir, ZDotDir string
	Source, CapturedAt                                            string
}

func CaptureUserEnvironment(context.Context) (UserExecutableEnvironment, error) {
	return UserExecutableEnvironment{}, errHostRuntime
}

func DiscoverInstalledHostRuntime(context.Context) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}
func DiscoverInstalledHostRuntimeForPath(context.Context, string) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}
func DiscoverInstalledHostRuntimeForEnvironment(context.Context, UserExecutableEnvironment) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}
func CaptureUserExecutablePath(context.Context) (string, error) {
	return "", errHostRuntime
}

func (nativePlatformFacts) hostRuntime(context.Context, *HostRuntimePlan) error {
	return errHostRuntime
}

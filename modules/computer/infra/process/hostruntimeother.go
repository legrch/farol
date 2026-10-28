//go:build !darwin

package process

import "context"

func DiscoverInstalledHostRuntime(context.Context) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}

func (nativePlatformFacts) hostRuntime(context.Context, *HostRuntimePlan) error {
	return errHostRuntime
}

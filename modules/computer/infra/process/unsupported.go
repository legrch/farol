//go:build !darwin

package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"io"
	"os"
	"os/exec"
)

func configure(*exec.Cmd) error         { return &processsvc.NativeFailure{} }
func exitDetails(*os.ProcessState) exit { return exit{} }

type nativeBoundary struct{ qualification Qualification }

func (nativeBoundary) Start(context.Context, Command, func(context.Context) error, io.Writer, io.Writer) (owned, error) {
	return nil, &processsvc.NativeFailure{}
}

func DiscoverInstalledHostRuntime(context.Context) (*HostRuntimePlan, error) {
	return nil, errHostRuntime
}

func (nativePlatformFacts) hostRuntime(context.Context, *HostRuntimePlan) error {
	return errHostRuntime
}

func measureLaunch(context.Context, Command, *confinedLaunch) (func(), error) {
	return nil, &processsvc.NativeFailure{}
}

func retainLaunch(context.Context, Command, *confinedLaunch) (*retainedLaunchMeasurement, error) {
	return nil, &processsvc.NativeFailure{}
}

// No fallback, observed-platform approval or emulation route.
type nativePlatformFacts struct{}

func (nativePlatformFacts) effectiveUID() uint32 { return 0 }
func (nativePlatformFacts) platform(context.Context) (platformFacts, error) {
	return platformFacts{}, &processsvc.NativeFailure{}
}
func (nativePlatformFacts) backend(context.Context) (string, error) {
	return "", &processsvc.NativeFailure{}
}
func (nativePlatformFacts) file(context.Context, string) (platformFileFacts, error) {
	return platformFileFacts{}, &processsvc.NativeFailure{}
}
func (nativePlatformFacts) directory(context.Context, string) (platformDirectoryFacts, error) {
	return platformDirectoryFacts{}, &processsvc.NativeFailure{}
}

func recheckPythonAlias(context.Context, *pythonAliasMeasurement) error {
	return &processsvc.NativeFailure{}
}

type nativeWatchdogHost struct{}

func (nativeWatchdogHost) Start(context.Context, WatchdogSelection, string, func() error) (watchdogProcess, watchdogChannel, error) {
	return nil, nil, &processsvc.NativeFailure{}
}

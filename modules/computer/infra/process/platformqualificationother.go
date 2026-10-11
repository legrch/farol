//go:build !darwin

package process

import (
	"context"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

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

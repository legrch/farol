//go:build !darwin

package execution

import (
	"context"
	"errors"
	"time"
)

// Post-launch image verification reads Darwin kernel state. Elsewhere the
// relaunch capability is unavailable and refuses rather than skipping the check.
type unsupportedPlatform struct{}

var errLaunchUnsupported = errors.New("post-launch verification unsupported on this platform")

func nativeLaunchPlatform() launchPlatform { return unsupportedPlatform{} }

func (unsupportedPlatform) open(context.Context, time.Time, []string, func(context.Context) error) error {
	return fail("launch_unsupported", false, false, errLaunchUnsupported)
}
func (unsupportedPlatform) candidates(context.Context, string) ([]int, error) {
	return nil, errLaunchUnsupported
}
func (unsupportedPlatform) image(int) (liveImage, error) { return liveImage{}, errLaunchUnsupported }
func (unsupportedPlatform) start(int) (processStart, error) {
	return processStart{}, errLaunchUnsupported
}
func (unsupportedPlatform) watch(int) (exitWatch, error) { return nil, errLaunchUnsupported }
func (unsupportedPlatform) kill(int) error               { return errLaunchUnsupported }
func (unsupportedPlatform) now() time.Time               { return time.Now() }
func (unsupportedPlatform) sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return ctx.Err()
	case <-ctx.Done():
		return ctx.Err()
	}
}

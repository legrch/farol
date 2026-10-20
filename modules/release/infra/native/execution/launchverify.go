package execution

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Post-launch image verification is DETECTION, never prevention. After the one
// original /usr/bin/open returns, the launched child is found by the exact
// relaunch argument and its kernel-reported code-signing identity is compared
// with the identity derived from the already verified image. A substituted
// executable has already run by then; it is killed only on a confirmed,
// repeated mismatch. Nothing here retries, replays or opens a journal phase,
// and no step outlives the original deadline.
//
// Under the cooperative-writer contract a hostile writer running as the same
// user is out of scope. Only the main executable image is bound: resources
// (such as app.asar) are not covered by a code-signing hash for the unsigned
// package and stay bound only by the tree digest checked before and after.

const (
	// launchDiscoveryCap bounds polling for the child after open returned. It is
	// always further shortened by the original deadline.
	launchDiscoveryCap   = 3 * time.Second
	launchPollInterval   = 10 * time.Millisecond
	launchMismatchSettle = 50 * time.Millisecond
)

// processStart is a process birth instant with microsecond resolution.
type processStart struct{ Seconds, Microseconds int64 }

// liveImage is what the kernel reports about one running process.
type liveImage struct {
	Image launchImage
	Start processStart
}

// errProcessGone reports that a pid no longer names a live process.
var errProcessGone = errors.New("process gone")

// launchPlatform is the private OS seam. Every kernel, process and time effect
// of the launch passes through it, so tests drive each branch deterministically.
// It grants no authority: the runtime decides what to ask and when.
type launchPlatform interface {
	// open is the original single launch. It returns when open has returned.
	open(ctx context.Context, until time.Time, arguments []string, fence func(context.Context) error) error
	// candidates lists same-effective-user processes whose arguments hold exactly
	// the given argument, excluding this process.
	candidates(ctx context.Context, argument string) ([]int, error)
	// image reads the kernel code-signing hash, executable object and birth time.
	image(pid int) (liveImage, error)
	// start rereads a process birth time.
	start(pid int) (processStart, error)
	// watch registers for the exit of exactly one process. It reports
	// errProcessGone when that process no longer exists. The caller closes it.
	watch(pid int) (exitWatch, error)
	// kill sends SIGKILL to exactly one pid.
	kill(pid int) error
	now() time.Time
	sleep(ctx context.Context, d time.Duration) error
}

// exitWatch observes whether the registered process has exited since watch
// returned. exited never blocks.
type exitWatch interface {
	exited() (bool, error)
	close() error
}

func launchUnverified(cause error, uncertain bool) error {
	return fail("launch_unverified", false, uncertain, cause)
}

// relaunchHint requires the single argument the child is found by to be the
// protocol hint: it names this operation and this helper instance, so it is a
// nonce for the launch that a different operation or helper cannot share.
func relaunchHint(operationID string, helperPID int64, arguments []string) (string, bool) {
	if len(arguments) != 5 {
		return "", false
	}
	hint := arguments[4]
	const prefix = "--farol-installed-update-relaunch="
	if !strings.HasPrefix(hint, prefix) || operationID == "" {
		return "", false
	}
	if !strings.Contains(hint, `"operationId":"`+operationID+`"`) || !strings.Contains(hint, `"pid":`+strconv.FormatInt(helperPID, 10)+`,`) {
		return "", false
	}
	return hint, true
}

// verifyLaunched runs inside the existing launch:open scope after open
// returned. verify is the scope's own held-tree check; it runs once more on
// success. want is the identity derived from the verified image before launch.
func verifyLaunched(ctx context.Context, p launchPlatform, hint string, want launchImage, verify func(context.Context) error) error {
	end := p.now().Add(launchDiscoveryCap)
	type observation struct {
		pid  int
		live liveImage
		at   time.Time
	}
	var pending *observation
	for {
		if err := ctx.Err(); err != nil {
			return launchUnverified(err, true)
		}
		pids, err := p.candidates(ctx, hint)
		if err != nil {
			return launchUnverified(err, true)
		}
		switch {
		case len(pids) > 1:
			// More than one process carries the nonce: which one is ours is
			// unknowable, so nothing is killed and the outcome stays unknown.
			return fail("launch_image_ambiguous", false, true, nil)
		case len(pids) == 1:
			live, err := p.image(pids[0])
			switch {
			case errors.Is(err, errProcessGone):
				pending = nil
			case err != nil:
				return launchUnverified(err, true)
			case live.Image == want:
				return verify(ctx)
			default:
				if pending != nil && pending.pid == pids[0] && pending.live == live && p.now().Sub(pending.at) >= launchMismatchSettle {
					return refuseLaunchedImage(ctx, p, pids[0], live)
				}
				if pending == nil || pending.pid != pids[0] || pending.live != live {
					pending = &observation{pid: pids[0], live: live, at: p.now()}
				}
			}
		default:
			pending = nil
		}
		if !p.now().Before(end) {
			return launchUnverified(nil, true)
		}
		if err := p.sleep(ctx, launchPollInterval); err != nil {
			return launchUnverified(err, true)
		}
	}
}

// refuseLaunchedImage contains a confirmed substitute. A pid alone cannot name
// a process, so the kill is bound to the observed one in three steps: an exit
// watch is registered first, the birth time must still equal the observed one,
// and a zero-timeout poll of the watch must show no exit immediately before the
// signal. The result is the definite classified refusal when the signal was
// sent; the retained launch image is untouched.
//
// Residual window: between that last poll and the kill system call the target
// can still exit and its pid be recycled by an unrelated process, which needs a
// full pid wraparound inside that interval. macOS has no pidfd, so this is
// reduced, not eliminated.
//
// A late observation never reaches the signal: the context, which carries the
// original deadline, is checked again before the watch is registered and
// immediately before the kill, and an expired one leaves the outcome uncertain.
func refuseLaunchedImage(ctx context.Context, p launchPlatform, pid int, observed liveImage) error {
	if err := ctx.Err(); err != nil {
		return fail("launch_image_mismatch", false, true, err)
	}
	watch, err := p.watch(pid)
	switch {
	case errors.Is(err, errProcessGone):
		return fail("launch_image_mismatch", false, true, errors.New("substitute exited before containment"))
	case err != nil:
		return fail("launch_image_mismatch", false, true, err)
	}
	result := containWatched(ctx, p, watch, pid, observed)
	if err := watch.close(); err != nil {
		return fail("launch_image_mismatch", false, true, errors.Join(err, result))
	}
	return result
}

func containWatched(ctx context.Context, p launchPlatform, watch exitWatch, pid int, observed liveImage) error {
	current, err := p.start(pid)
	switch {
	case errors.Is(err, errProcessGone):
		return fail("launch_image_mismatch", false, true, errors.New("substitute exited before containment"))
	case err != nil:
		return fail("launch_image_mismatch", false, true, err)
	case current != observed.Start:
		return fail("launch_image_mismatch", false, true, errors.New("process start changed; nothing killed"))
	}
	exited, err := watch.exited()
	switch {
	case err != nil:
		return fail("launch_image_mismatch", false, true, err)
	case exited:
		return fail("launch_image_mismatch", false, true, errors.New("substitute exited after registration; nothing killed"))
	}
	if err := ctx.Err(); err != nil {
		return fail("launch_image_mismatch", false, true, err)
	}
	// Only a signal that was actually delivered is definite. ESRCH means none
	// was sent, so the outcome for the substitute is unknown.
	if err := p.kill(pid); err != nil {
		return fail("launch_image_mismatch", false, true, err)
	}
	return fail("launch_image_mismatch", false, false, nil)
}

//go:build darwin

package mutation

import (
	"context"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
)

var machineBootSession = regexp.MustCompile(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

// InspectPreservedAfterMachineRestart is explicit trusted-owner maintenance only.
// beforeBootSession must come from the owner's independently pinned pre-restart
// plan, not a runtime tool, renderer, workspace request, guessed UUID or clock.
// The actual current session comes exclusively from the native kernel. Its change
// excludes processes from the selected before-session; historical cleanup and
// operation outcomes remain unchanged. This is NOT ordinary startup permission.
func InspectPreservedAfterMachineRestart(ctx context.Context, root Root, selection SettledSelection, expected []ExpectedPreservedRecord, beforeBootSession string, visit func(PreservedInspection) error) (*PreservedInspection, error) {
	return inspectPreservedAfterMachineRestart(ctx, root, selection, expected, beforeBootSession, visit, func() (string, error) { return unix.Sysctl("kern.bootsessionuuid") })
}

// Injectable only inside this package's synthetic transition tests. Production
// composition never accepts a caller-supplied current session or a restart bool.
func inspectPreservedAfterMachineRestart(ctx context.Context, root Root, selection SettledSelection, expected []ExpectedPreservedRecord, before string, visit func(PreservedInspection) error, readCurrent func() (string, error)) (*PreservedInspection, error) {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) || visit == nil || readCurrent == nil || !machineBootSession.MatchString(before) {
		return nil, unavailable()
	}
	current, err := readCurrent()
	current = strings.ToLower(strings.TrimSpace(current))
	if err != nil || !machineBootSession.MatchString(current) || current == before {
		return nil, failure("COMPUTER_MACHINE_RESTART_UNVERIFIED")
	}
	verify := func() error {
		actual, err := readCurrent()
		if ctx.Err() != nil || err != nil || strings.ToLower(strings.TrimSpace(actual)) != current {
			return failure("COMPUTER_MACHINE_RESTART_UNVERIFIED")
		}
		return nil
	}
	closed, err := selectPreserved(selection, expected)
	if err != nil {
		return nil, err
	}
	var result *PreservedInspection
	err = inspectBoundedNative(ctx, root, len(expected), func(o settledObservation) (err error) {
		result, err = observePreservedPolicy(ctx, closed, o, visit, verify)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

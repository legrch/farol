//go:build !darwin

package observation

import (
	"context"
	port "github.com/legrch/farol/modules/computer/app/port/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

// No inode-only fallback, including on Linux. Portable tests inject facts and
// are not evidence of a native APFS remount, reboot, or volume UUID.
func (*Probe) Observe(ctx context.Context, _ string) (identity.Observation, error) {
	if err := cancelled(ctx); err != nil {
		return identity.Observation{}, err
	}
	return identity.Observation{}, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
}

func (*Holder) Hold(ctx context.Context, _ string) (port.HeldObservation, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	return nil, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
}

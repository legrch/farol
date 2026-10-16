//go:build darwin || linux

package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func acquirePreservationInspection(ctx context.Context, roots Roots, scope port.JournalScope) (*PreservationLease, error) {
	chain, verify, close, err := acquireInspectionChain(ctx, roots, preservationChainScan, func(chain closedInspectionChain) error {
		_, err := preservationValue(roots, scope, chain)
		return err
	})
	if err != nil {
		return nil, err
	}
	value, _ := preservationValue(roots, scope, chain)
	return &PreservationLease{lifetime: &ClosedLease{verify: verify, close: close}, value: value, ctx: ctx}, nil
}

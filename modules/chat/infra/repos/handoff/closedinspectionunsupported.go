//go:build !darwin && !linux

package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func withClosedInspection(context.Context, Roots, port.JournalScope, func(ClosedInspection) error) error {
	return fail(Unavailable, false)
}

func acquireClosedInspection(context.Context, Roots, port.JournalScope) (*ClosedLease, error) {
	return nil, fail(Unavailable, false)
}

func acquireInterruptedRetirementInspection(context.Context, Roots, port.JournalScope) (*ClosedLease, error) {
	return nil, fail(Unavailable, false)
}

func acquireAcknowledgedInspection(context.Context, Roots, port.HandoffBinding, string) (*AcknowledgedLease, error) {
	return nil, fail(Unavailable, false)
}

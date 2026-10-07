//go:build !darwin && !linux

package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func withClosedInspection(context.Context, Root, port.JournalScope, Limits, func(ClosedInspection) error) error {
	return failure(Unavailable, false)
}

func acquireClosedInspection(context.Context, Root, port.JournalScope, Limits) (*ClosedLease, error) {
	return nil, failure(Unavailable, false)
}

func acquireInterruptedRetirementInspection(context.Context, Root, port.JournalScope, Limits) (*ClosedLease, error) {
	return nil, failure(Unavailable, false)
}

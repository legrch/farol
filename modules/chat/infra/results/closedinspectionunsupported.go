//go:build !darwin && !linux

package results

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func withClosedInspection(context.Context, Root, port.JournalScope, func(ClosedInspection) error) error {
	return Unavailable
}

func acquireClosedInspection(context.Context, Root, port.JournalScope) (*ClosedLease, error) {
	return nil, Unavailable
}

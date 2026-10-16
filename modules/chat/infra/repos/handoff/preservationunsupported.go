//go:build !darwin && !linux

package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func acquirePreservationInspection(context.Context, Roots, port.JournalScope) (*PreservationLease, error) {
	return nil, fail(Unavailable, false)
}

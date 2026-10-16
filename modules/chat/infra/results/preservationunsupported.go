//go:build !darwin && !linux

package results

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func acquirePreservationInspection(context.Context, Root, port.JournalScope, Limits) (*PreservationLease, error) {
	return nil, Unavailable
}

//go:build !darwin && !linux

package handoff

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

func withClosedInspection(context.Context, Roots, port.JournalScope, func(ClosedInspection) error) error {
	return fail(Unavailable, false)
}

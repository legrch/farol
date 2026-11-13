//go:build !darwin

package boot

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

type preservedProfileInventory struct{}

func capturePreservedProfileInventory(context.Context, preservedProfileInspectionInput, NativeRoot) (*preservedProfileInventory, error) {
	return nil, handoff.Refused
}
func verifyPreservedProfileInventory(context.Context, *preservedProfileInventory, *emptyRecoveryPreservation) error {
	return handoff.Refused
}

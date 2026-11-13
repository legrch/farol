//go:build !darwin

package boot

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

func preserveEmptyRecoveryChat(context.Context, emptyRecoveryInspectionInput, emptyRecoveryInspection, *emptyRecoveryChatClaims) (*emptyRecoveryPreservation, error) {
	return nil, handoff.Refused
}
func verifyEmptyRecoveryPreservation(context.Context, ProfileBinding, NativeRoot, NativeRoot, *emptyRecoveryPreservation) error {
	return handoff.Refused
}

func refusePendingEmptyRecovery(ProfileBinding) error { return handoff.Refused }

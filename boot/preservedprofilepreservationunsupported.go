//go:build !darwin

package boot

import (
	"context"
	archivepolicy "github.com/legrch/farol/modules/chat/app/capabilities/archive"
)

func preserveNonemptyRecoveryChat(context.Context, preservedProfileInspectionInput, preservedProfileInspection, *preservedProfileChatClaims) (*emptyRecoveryPreservation, error) {
	return nil, archivepolicy.Refused
}

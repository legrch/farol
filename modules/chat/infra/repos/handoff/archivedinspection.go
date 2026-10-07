package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/legrch/farol/modules/chat/app/port"
)

// ArchivedRecord contains already physically qualified private bytes. It is not
// a native lease or origin/drain proof. The owning adapter rechecks its complete
// immutable inventory before and after this pure full-chain validation.
type ArchivedRecord struct {
	Attempt []byte
	Commit  string
}

// ValidateArchivedEmptyRecords reuses the complete canonical storage scanner;
// no second transition implementation or native writer is constructed. Every
// commit and record, including early ancestors, must link to the selected head.
func ValidateArchivedEmptyRecords(ctx context.Context, roots Roots, selected port.HandoffBinding, expectedHead [32]byte, records []ArchivedRecord) error {
	if ctx == nil || ctx.Err() != nil || len(records) == 0 || len(records) > maxSteps || expectedHead == ([32]byte{}) || selected.ProfileID != roots.ProfileID || selected.ParentRoot != roots.Parent.Identity || selected.ChatRoot != roots.Chat.Identity {
		return fail(Refused, false)
	}
	copy := make([][]byte, len(records))
	total := 0
	for n, r := range records {
		if len(r.Attempt) == 0 || len(r.Attempt) > 16384 || total+len(r.Attempt) > 4194304 {
			return fail(Refused, false)
		}
		total += len(r.Attempt)
		digest := sha256.Sum256(r.Attempt)
		if r.Commit != hex.EncodeToString(digest[:]) {
			return fail(Refused, false)
		}
		copy[n] = append([]byte(nil), r.Attempt...)
	}
	scope := port.JournalScope{ProfileID: selected.ProfileID, BackendGeneration: selected.BackendGeneration}
	value, err := closedInspectionScan(ctx, roots, scope, func(ctx context.Context, index int) ([]byte, bool, error) {
		if ctx.Err() != nil {
			return nil, false, fail(Cancelled, false)
		}
		if index > len(copy) {
			return nil, false, nil
		}
		return copy[index-1], true, nil
	})
	if err != nil || value.HeadDigest != expectedHead || value.NextBinding != selected || len(value.Stages) != len(records) {
		return fail(Refused, false)
	}
	return nil
}

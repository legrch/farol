package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/pkg/kernel/domain/digest"
)

func planReceipt(request journal.Request, phase journal.Phase) journal.Receipt {
	digest := sha256.Sum256([]byte("farol.continuity-plan/1\x00" + request.OperationID + "\x00" +
		request.RequestDigest + "\x00" + string(phase)))
	return journal.Receipt{EffectID: request.OperationID + "_" + string(phase), Digest: hex.EncodeToString(digest[:])}
}

func (o *Owner) Plan(ctx context.Context, id string, phase journal.Phase) (journal.Receipt, error) {
	switch phase {
	case journal.WithdrawIntent, journal.SettingsIntent, journal.PublishIntent, journal.CloseIntent:
	default:
		return journal.Receipt{}, journal.ErrRefused
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	a := o.active
	if o.poisoned || a == nil || a.request.OperationID != id || ctx == nil || ctx.Err() != nil {
		return journal.Receipt{}, journal.ErrRefused
	}
	return planReceipt(a.request, phase), nil
}

func (a *held) canRecord(phase journal.Phase, receipt journal.Receipt) bool {
	switch phase {
	case journal.WithdrawIntent:
		return a.phase == journal.Prepared && receipt == planReceipt(a.request, phase)
	case journal.WithdrawAcknowledged:
		return a.phase == journal.WithdrawIntent && a.withdrawAck != nil && *a.withdrawAck == receipt
	case journal.SettingsIntent:
		return a.phase == journal.WithdrawAcknowledged && receipt == planReceipt(a.request, phase)
	case journal.SettingsAcknowledged:
		planned := planReceipt(a.request, journal.SettingsIntent)
		return a.phase == journal.SettingsIntent && receipt.EffectID == planned.EffectID && digest.Valid(receipt.Digest) && receipt.Digest != planned.Digest
	case journal.PublishIntent:
		return a.phase == journal.SettingsAcknowledged && receipt == planReceipt(a.request, phase)
	case journal.PublishAcknowledged:
		return a.phase == journal.PublishIntent && a.stageAttempted && a.stageAck == receipt && receipt.EffectID != ""
	case journal.CloseIntent:
		return a.phase == journal.PublishAcknowledged && receipt == planReceipt(a.request, phase)
	default:
		return false
	}
}

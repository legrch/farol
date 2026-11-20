package migration

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
	"github.com/legrch/farol/pkg/kernel/domain/digest"
)

// StageEffect is Go-only. It stages the measured identity under the exact
// durable publish intent and returns the Store's original publication receipt.
type StageEffect func(context.Context, string, journal.Receipt, observation.Observation) (journal.Receipt, error)

func (o *Owner) StageOnce(ctx context.Context, id string, effect StageEffect) (journal.Receipt, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	a := o.active
	if o.poisoned || a == nil || a.request.OperationID != id || a.phase != journal.PublishIntent ||
		a.stageAttempted || effect == nil || ctx == nil || ctx.Err() != nil {
		return journal.Receipt{}, journal.ErrRefused
	}
	if err := a.anchor.Requalify(ctx); err != nil {
		o.poisoned = true
		return journal.Receipt{}, err
	}
	if err := a.candidate.Requalify(ctx); err != nil {
		o.poisoned = true
		return journal.Receipt{}, err
	}
	planned := planReceipt(a.request, journal.PublishIntent)
	a.stageAttempted = true
	ack, err := effect(ctx, id, planned, a.measured)
	if err != nil {
		o.poisoned = true
		return journal.Receipt{}, err
	}
	if ack.EffectID != planned.EffectID || !digest.Valid(ack.Digest) || ack.Digest == planned.Digest || ctx.Err() != nil {
		o.poisoned = true
		return journal.Receipt{}, journal.ErrUnknown
	}
	a.stageAck = ack
	return ack, nil
}

// Close retires this runtime's held descriptors without writing a terminal
// certificate. A previous close attempt is never repeated.
func (o *Owner) Close() error {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.poisoned = true
	if o.active == nil {
		return nil
	}
	return o.active.close()
}

func (a *held) close() error {
	if !a.closeAttempted {
		a.closeAttempted = true
		a.closeErr = errors.Join(a.candidate.Close(), a.anchor.Close())
	}
	return a.closeErr
}

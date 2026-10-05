package mutation

import (
	"bytes"
	"context"
	"errors"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

type connectorProcessReservation struct {
	repository *Repository
	scope      processsvc.ConnectorReservationScope
}

var _ processsvc.Reservation = (*connectorProcessReservation)(nil)

// ConnectorProcessReservation retains scalar correlation only, with no IO.
// Reserve shares this repository's lock, storage, fence and Close lifetime.
func (r *Repository) ConnectorProcessReservation(scope processsvc.ConnectorReservationScope) (processsvc.Reservation, error) {
	if !validProcessScope(scope) {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	if r == nil {
		return nil, unavailable()
	}
	return &connectorProcessReservation{repository: r, scope: scope}, nil
}

func processIdentity(scope processsvc.ConnectorReservationScope, operationID string) domain.Identity {
	return domain.Identity{Scope: domain.ScopeConnector, OperationID: operationID, OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID}
}

func (a *connectorProcessReservation) Reserve(ctx context.Context, intent processsvc.Intent) (*processsvc.ReservationReceipt, error) {
	if a == nil {
		return nil, unavailable()
	}
	// Validate every value before even checking the injected storage.
	raw, err := encodeProcess(a.scope, intent)
	if err != nil {
		return nil, err
	}
	key, err := recordKey(processIdentity(a.scope, intent.OperationID))
	if err != nil {
		return nil, err
	}
	r := a.repository
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	observed, err := r.disk.read(key)
	if err != nil {
		return nil, unavailable()
	}
	if observed != nil {
		return a.existing(ctx, raw, observed)
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	err = r.disk.create(key, bytes.Clone(raw))
	if errors.Is(err, errExists) {
		// The racing writer owns any fresh permit, even for identical bytes.
		observed, err = r.disk.read(key)
		if err != nil || observed == nil || ctx.Err() != nil || r.disk.check() != nil {
			r.fenced = true
			return nil, unknown()
		}
		_, original, decodeErr := decodeProcess(observed)
		if decodeErr != nil || ctx.Err() != nil || r.disk.check() != nil {
			r.fenced = true
			return nil, unknown()
		}
		if !bytes.Equal(raw, observed) {
			return nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
		}
		return &processsvc.ReservationReceipt{Status: processsvc.Existing, Intent: original}, nil
	}
	if err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return nil, unknown()
	}
	observed, err = r.disk.read(key)
	if err != nil || !bytes.Equal(raw, observed) || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return nil, unknown()
	}
	// Exact readback of validated canonical bytes; preserve the original time value.
	return &processsvc.ReservationReceipt{Status: processsvc.Reserved, Intent: intent}, nil
}

func (a *connectorProcessReservation) existing(ctx context.Context, expected, observed []byte) (*processsvc.ReservationReceipt, error) {
	_, intent, err := decodeProcess(observed)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(expected, observed) {
		return nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	if err = a.repository.ready(ctx); err != nil {
		return nil, err
	}
	return &processsvc.ReservationReceipt{Status: processsvc.Existing, Intent: intent}, nil
}

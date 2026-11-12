package boot

import (
	"context"

	wire "github.com/legrch/farol/gen/desktop/v1"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// continuityStatus reads the protected original Go WAL without opening the
// ordinary approval gate. It is diagnostic-only: matching historical settings
// bytes or a terminal certificate never constitutes current authority.
func (s *ComputerIngress) continuityStatus(ctx context.Context) (*wire.ComputerContinuityStatusResponse, error) {
	if s == nil || ctx == nil || ctx.Err() != nil {
		return nil, computerUnavailable()
	}
	store, ok := s.store.(interface {
		TransitionStatus(context.Context) (accessrepo.TransitionState, error)
		CurrentContinuityStatus(context.Context) (accessrepo.CurrentTransitionReceipt, error)
	})
	if !ok {
		return nil, computerUnavailable()
	}
	state, err := store.TransitionStatus(ctx)
	if err != nil {
		return nil, err
	}
	result := &wire.ComputerContinuityStatusResponse{
		Present: state.Present, Restricted: state.Restricted,
		EntryCount: uint32(len(state.Journal.Entries)), Delivery: state.Delivery,
	}
	if result.Delivery != "not_recorded" {
		return nil, computerUnavailable()
	}
	for _, entry := range state.Journal.Entries {
		if !entryDischarged(entry) && entry.Phase != journal.Committed && entry.Phase != journal.Refused {
			if result.PendingOperationId != nil {
				return nil, computerUnavailable()
			}
			id, phase := entry.Request.OperationID, string(entry.Phase)
			result.PendingOperationId, result.PendingPhase = &id, &phase
		}
	}
	if !state.Restricted && state.Present {
		if _, err := store.CurrentContinuityStatus(ctx); err == nil {
			result.CurrentQualified = true
		}
	}
	return result, nil
}

func entryDischarged(e journal.Entry) bool { return e.DischargedBy != "" }

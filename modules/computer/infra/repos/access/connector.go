package access

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// ConnectorJournal is a narrow adapter over the EXISTING Store. It has no
// mutable state, registry, liveness cache or second persistence mechanism.
type ConnectorJournal struct{ store *Store }

var _ port.ConnectorJournal = (*ConnectorJournal)(nil)

func NewConnectorJournal(store *Store) (*ConnectorJournal, error) {
	if store == nil {
		return nil, unavailable()
	}
	return &ConnectorJournal{store: store}, nil
}

func (r *ConnectorJournal) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	return r.store.WithSnapshot(ctx, id, inspect)
}

func (r *ConnectorJournal) PublishConnector(ctx context.Context, input port.ConnectorLaunch) (port.ConnectorPublication, error) {
	var result port.ConnectorPublication
	if input.Host.ProfileID != r.store.binding.ProfileID {
		return result, unavailable()
	}
	var before Status
	var expected authority.Participant
	err := r.store.WithOwnerApproval(ctx, func(status Status, a *authority.Approval) error {
		if a == nil || !authority.SameApprovalPolicy(*a, input.Approval) {
			return unavailable()
		}
		g, err := authority.Derive(*a, input.Admission, r.store.clock.Now())
		if err != nil {
			return err
		}
		p, err := authority.Create(*g, input.Participant)
		if err != nil {
			return err
		}
		expected, before = p.Clone(), status
		return nil
	})
	if err != nil {
		return result, err
	}
	// Persisted participants are never restored as positive host liveness.
	err = r.store.WithSnapshot(ctx, expected.ParticipantID, func(v port.AccessSnapshot) error {
		if v.Participant != nil {
			return unavailable()
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	if before.Revision == ^uint64(0) {
		return result, unavailable()
	}
	p, err := r.store.Admit(ctx, before.Revision, input.Admission, input.Participant)
	if err != nil {
		return result, err
	}
	if p == nil || !authority.SameParticipantCeiling(*p, expected) || !p.Grant.ExpiresAt.Equal(expected.Grant.ExpiresAt) {
		return result, unavailable()
	}
	// Admit's known reply is necessary but insufficient: bind the exact revision
	// and readback under the Store gate. Never retry a revision conflict/unknown.
	err = r.store.WithOwnerApproval(ctx, func(status Status, a *authority.Approval) error {
		if status.Revision != before.Revision+1 || a == nil || !authority.SameApprovalPolicy(*a, input.Approval) {
			return unavailable()
		}
		result.Revision, result.Approval = status.Revision, a.Clone()
		return nil
	})
	if err != nil {
		return port.ConnectorPublication{}, err
	}
	err = r.store.WithSnapshot(ctx, p.ParticipantID, func(v port.AccessSnapshot) error {
		if v.Participant == nil || v.Approval == nil || !authority.SameParticipantCeiling(*v.Participant, *p) || !v.Participant.Grant.ExpiresAt.Equal(p.Grant.ExpiresAt) || !authority.SameApprovalPolicy(*v.Approval, result.Approval) {
			return unavailable()
		}
		result.Participant = v.Participant.Clone()
		return nil
	})
	if err != nil {
		return port.ConnectorPublication{}, err
	}
	result.OriginalPublished = true
	return result, nil
}

func (r *ConnectorJournal) WithdrawConnector(ctx context.Context, id string) error {
	before, err := r.store.Status(ctx)
	if err != nil {
		return err
	}
	if before.Revision == ^uint64(0) {
		return unavailable()
	}
	if err = r.store.RevokeParticipant(ctx, before.Revision, id); err != nil {
		return err
	}
	after, err := r.store.Status(ctx)
	if err != nil {
		return err
	}
	if after.Revision != before.Revision+1 {
		return unavailable()
	}
	return r.store.WithSnapshot(ctx, id, func(v port.AccessSnapshot) error {
		if v.Participant != nil {
			return unavailable()
		}
		return nil
	})
}

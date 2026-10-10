package planresponses

import (
	"context"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/app/services/inference"
)

// SelectedAccountSource is the trusted account owner's current selection fence.
// The callback and nested account grant check are synchronous and perform no IO.
// Implementations serialize the WHOLE callback against account/catalogue change.
// A snapshot or a decoded OAuth identity is not an implementation of this port.
type SelectedAccountSource interface {
	WithSelected(context.Context, inference.Selection, func(chatport.AccountObservation) error) error
}

// ConsentFence adapts the existing private Chat account grant, without minting
// grants from token scopes or treating Computer renewal as OAuth consent.
type ConsentFence struct {
	grant     *accountapproval.Grant
	scope     chatport.AccountScope
	selection inference.Selection
	source    SelectedAccountSource
}

func NewConsentFence(grant *accountapproval.Grant, scope chatport.AccountScope, selected inference.Selection, source SelectedAccountSource) (*ConsentFence, error) {
	if grant == nil || source == nil || !inference.ValidSelection(selected) || scope.ProfileID == "" || scope.BackendGeneration == "" || scope.OwnerID == "" || scope.SessionID == "" {
		return nil, inference.Invalid
	}
	return &ConsentFence{grant: grant, scope: scope, selection: selected, source: source}, nil
}

func (f *ConsentFence) WithCurrent(ctx context.Context, b inference.Binding, inspect func() error) error {
	if f == nil || ctx == nil || inspect == nil || ctx.Err() != nil || b.Selection != f.selection || b.ProfileID != f.scope.ProfileID || b.BackendGeneration != f.scope.BackendGeneration || b.OwnerID != f.scope.OwnerID || b.SessionID != f.scope.SessionID {
		return inference.Withdrawn
	}
	err := f.source.WithSelected(ctx, f.selection, func(observed chatport.AccountObservation) error {
		return f.grant.WithCurrent(ctx, f.scope, f.selection.ConsentID, observed, func(approval chatport.AccountApproval) error {
			if approval.Revision != f.selection.ConsentRevision {
				return inference.Withdrawn
			}
			return inspect()
		})
	})
	if err != nil {
		return inference.Withdrawn
	}
	return nil
}

var _ inference.Authority = (*ConsentFence)(nil)

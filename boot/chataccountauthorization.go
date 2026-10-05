package boot

import (
	"context"
	"errors"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
)

// This composition uses the existing private explicit approval and Chat Send
// capability. It grants no Computer access and constructs no read intent. The
// trusted creator must capture it before authorized admission; that entrypoint
// remains a separate integration boundary. Declaring an account ID or observing
// a session cannot create this grant.
type chatAccountAuthorization struct {
	account         capturedChatAccount
	original        conversation.Binding
	selectedAccount string
}

func newChatAccountAuthorization(account *capturedChatAccount, original conversation.Binding, selectedAccount string) (*chatAccountAuthorization, error) {
	if account == nil || account.grant == nil || !validIngressID(account.approvalID) || !validIngressID(selectedAccount) || original.TaskEpoch == 0 || original.TurnGeneration == 0 || validateIngress("ChatTurnBinding", chatWireBinding(original)) != nil {
		return nil, errors.New("chat_account_authorization_invalid")
	}
	// Copy the selected ID and original binding; later caller mutations cannot
	// substitute another account or conversation. The private Grant remains live
	// and its owning service can revoke or replace it before either turn's Send.
	return &chatAccountAuthorization{account: *account, original: original, selectedAccount: selectedAccount}, nil
}

func (a *chatAccountAuthorization) Authorize(ctx context.Context, current *conversation.SendCurrent) error {
	if a == nil || ctx == nil || current == nil || a.account.grant == nil {
		return errors.New("chat_account_authorization_invalid")
	}
	// A detached snapshot is evidence only. Read it before taking the account
	// gate, then enter account -> exact Chat dispatch without network or host IO.
	witness, err := current.AccountSnapshot(ctx)
	if err != nil || witness == nil {
		return errors.New("chat_account_unavailable")
	}
	b := a.original
	scope := chatport.AccountScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID}
	observed := chatport.AccountObservation{State: witness.State, Source: witness.Source, PrincipalKey: witness.PrincipalKey, ObservedAtMillis: witness.ObservedAtMillis, ExpiresAtMillis: witness.ExpiresAtMillis}
	return a.account.grant.WithCurrent(ctx, scope, a.account.approvalID, observed, func(approval chatport.AccountApproval) error {
		if approval.PrincipalKey != a.selectedAccount {
			return errors.New("chat_account_selection_crossed")
		}
		return current.WithCurrent(ctx, func(live *conversation.Binding) error {
			if live == nil || !chatAccountConversation(b, *live) {
				return errors.New("chat_account_conversation_crossed")
			}
			return nil
		})
	})
}

func chatAccountConversation(original, live conversation.Binding) bool {
	if live == original {
		return true
	}
	// The same captured guard follows the original conversation. Only its exact
	// current capability supplies the successor turn; no receipt reconstructs it.
	// TurnID reuse at a newer generation is valid when it differs from the
	// immediate predecessor. The existing Follow owner enforces that comparison.
	return live.ProfileID == original.ProfileID && live.BackendGeneration == original.BackendGeneration && live.OwnerID == original.OwnerID && live.SessionID == original.SessionID && live.TaskID == original.TaskID && live.TaskEpoch == original.TaskEpoch && live.ParticipantID == original.ParticipantID && live.TurnGeneration > original.TurnGeneration && live.OperationID != original.OperationID
}

var _ conversation.SendAuthorization = (*chatAccountAuthorization)(nil)

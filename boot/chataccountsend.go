package boot

import (
	"context"
	"errors"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	computerport "github.com/legrch/farol/modules/computer/app/port"
)

// Captured only by trusted explicit approval composition. This field is not a
// decoded body ID, declared AccountID, observation, or reconstructed live grant.
// A legacy unqualified route does not acquire account authority by omission.
type capturedChatAccount struct {
	grant      *accountapproval.Grant
	approvalID string
}

type accountSendAdmission struct {
	captured *capturedChatAccount
	scope    chatport.AccountScope
	snapshot chatport.AccountObservation
	current  computerport.CurrentTaskAdmission
}

func (a *capturedChatAccount) forSend(ctx context.Context, current *conversation.SendCurrent, binding conversation.Binding, next computerport.CurrentTaskAdmission) (*accountSendAdmission, error) {
	if a == nil || a.grant == nil || current == nil || next == nil {
		return nil, errors.New("chat_account_unavailable")
	}
	// Take an immutable fact copy before outer guards. This read cannot authorize
	// Send. The later Chat guard independently checks the same entire verification.
	snapshot, err := current.AccountSnapshot(ctx)
	if err != nil || snapshot == nil {
		return nil, errors.New("chat_account_unavailable")
	}
	return &accountSendAdmission{captured: a, scope: chatport.AccountScope{ProfileID: binding.ProfileID, BackendGeneration: binding.BackendGeneration, OwnerID: binding.OwnerID, SessionID: binding.SessionID}, snapshot: chatport.AccountObservation{State: snapshot.State, Source: snapshot.Source, PrincipalKey: snapshot.PrincipalKey, ObservedAtMillis: snapshot.ObservedAtMillis, ExpiresAtMillis: snapshot.ExpiresAtMillis}, current: next}, nil
}

func (a *accountSendAdmission) WithCurrent(ctx context.Context, inspect func(*computerport.TaskBinding) error) error {
	if a == nil || a.captured == nil || a.current == nil || inspect == nil {
		return errors.New("chat_account_unavailable")
	}
	// Computer and activation guards are held by the caller. No browser/network IO
	// or owner mutation runs under account -> exact Chat dispatch guards.
	return a.captured.grant.WithCurrent(ctx, a.scope, a.captured.approvalID, a.snapshot, func(chatport.AccountApproval) error {
		return a.current.WithCurrent(ctx, inspect)
	})
}

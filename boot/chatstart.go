package boot

import (
	"context"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/app/services/modelselection"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/transport/desktop"
)

type chatStartAccount struct {
	captured capturedChatAccount
	owner    *accountapproval.Service
	model    *chatBrowserModel
}

// The trusted host calls start only after the owner explicitly confirms its
// retained account observation. Go resolves the captured model configuration,
// mints the existing private approval, and then admits the ordinary conversation.
// No Computer admission, browser IO or separate grant registry is involved.
func (s *ChatIngress) start(ctx context.Context, operation string, in wire.ChatStart) (*wire.ChatStarted, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || validateIngress("ChatStart", in) != nil || in.ConfirmedPrincipalKey != in.Observation.PrincipalKey {
		return nil, readAccountRefusal("chat_start_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.claimChatOperationCapacity(ctx, operation, 1); err != nil {
		return nil, err
	}
	policy, profiles, err := chatModelPolicy(in.Policy, in.Profiles)
	if err != nil {
		return nil, readAccountRefusal("chat_start_selection_invalid")
	}
	requested := in.Requested
	capture, err := modelselection.Resolve(intent.SHA256{}, policy, chatport.ModelRequest{Harness: requested.Harness, Model: requested.Model, Effort: requested.Effort, RequestedMode: requested.Mode}, profiles, in.ConfirmedPrincipalKey)
	if err != nil {
		return nil, readAccountRefusal(err.Error())
	}
	clock := s.accountClock
	if clock == nil {
		clock = browserClock{}
	}
	owner, err := accountapproval.New(chatport.AccountScope{ProfileID: s.peer.ProfileId, BackendGeneration: s.peer.BackendGeneration, OwnerID: s.owner, SessionID: in.SessionId}, gate.New(), clock)
	if err != nil {
		return nil, err
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	o := in.Observation
	grant, err := owner.Approve(ctx, id, 0, chatport.AccountObservation{State: o.State, Source: o.Source, PrincipalKey: o.PrincipalKey, ObservedAtMillis: wireUint(o.ObservedAtMillis), ExpiresAtMillis: wireUint(o.ExpiresAtMillis)})
	if err != nil {
		var code accountapproval.Code
		if errors.As(err, &code) {
			return nil, readAccountRefusal(code)
		}
		return nil, err
	}
	account := &chatStartAccount{captured: capturedChatAccount{grant: grant, approvalID: id}, owner: owner}
	account.model, err = captureChatBrowserModel(ctx, &account.captured, *capture, chatport.AccountScope{ProfileID: s.peer.ProfileId, BackendGeneration: s.peer.BackendGeneration, OwnerID: s.owner, SessionID: in.SessionId}, chatport.AccountObservation{State: o.State, Source: o.Source, PrincipalKey: o.PrincipalKey, ObservedAtMillis: wireUint(o.ObservedAtMillis), ExpiresAtMillis: wireUint(o.ExpiresAtMillis)}, clock)
	if err != nil {
		return nil, readAccountRefusal("chat_start_model_capture_invalid")
	}
	s.withdrawals[owner] = true
	selection := capture.Selection
	resolved := wire.BrowserSelection{Provider: selection.Provider, Alias: selection.Alias, AccountId: selection.AccountID, ModelId: selection.ModelID, Effort: selection.Effort, Mode: selection.Mode, ToolsEnabled: selection.ToolsEnabled, ConnectorId: selection.ConnectorID, ConnectorGrantId: selection.ConnectorGrantID}
	r := capture.Resolution
	resolution := wire.BrowserResolution{RequestedAlias: r.RequestedAlias, RequestedExecutor: r.RequestedExecutor, RequestedEffort: r.RequestedEffort, RequestedMode: r.RequestedMode, Resolved: resolved, ConfigSHA256: r.ConfigSHA256, TranslationId: r.TranslationID}
	required := wire.BrowserRequiredControls{Model: capture.Required.Model, Effort: capture.Required.Effort, Mode: capture.Required.Mode, Connector: capture.Required.Connector}
	input := wire.ChatCreate{SessionId: in.SessionId, Prompt: in.Prompt, Selection: resolved, Resolution: resolution, Required: required}
	if ctx.Err() != nil {
		return nil, errors.New("chat_start_unconfirmed")
	}
	handle, err := s.createLocked(ctx, operation, input, account)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, errors.New("chat_start_unconfirmed")
	}
	return &wire.ChatStarted{Handle: *handle, Selection: resolved, Resolution: resolution, Required: required}, nil
}

// Every successor handle keeps the same account service. Revoking through an
// earlier turn therefore also fences the current turn's final disclosure.
func (s *ChatIngress) revokeAccount(ctx context.Context, operation string, in wire.ChatHandleRequest) error {
	if s == nil || ctx == nil || validateIngress("ChatHandleRequest", in) != nil {
		return readAccountRefusal("chat_account_revoke_invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.handles[in.HandleId]
	if !ok || h.accountOwner == nil {
		return readAccountRefusal("chat_account_not_owned")
	}
	if !validIngressID(operation) || s.used[operation] || !s.withdrawals[h.accountOwner] || len(s.used) >= 1024 || ctx.Err() != nil {
		return readAccountRefusal("chat_account_revoke_refused")
	}
	// Convert only this owner's reserved slot into an operation entry. Consume
	// it before withdrawal so a late or unknown result is never replayed.
	s.used[operation] = true
	delete(s.withdrawals, h.accountOwner)
	revision, err := h.accountOwner.Revision(ctx)
	if err != nil {
		return err
	}
	if _, err = h.accountOwner.Revoke(ctx, revision); err != nil || ctx.Err() != nil {
		return errors.New("chat_account_revoke_unconfirmed")
	}
	return nil
}

func (s *ChatIngress) startMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.conversation.start": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatStart
			if r.OperationID == "" || chatDecode("ChatStart", r, &in) != nil {
				return invalidIngress()
			}
			v, err := s.start(ctx, r.OperationID, in)
			return readAccountOutcome("ChatStarted", v, err)
		}},
		"chat.conversation.account.revoke": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatHandleRequest
			if r.OperationID == "" || chatDecode("ChatHandleRequest", r, &in) != nil {
				return invalidIngress()
			}
			return readAccountOutcome("Empty", wire.Empty{}, s.revokeAccount(ctx, r.OperationID, in))
		}},
	}
}

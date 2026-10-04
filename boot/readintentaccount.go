package boot

import (
	"context"
	"errors"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/transport/desktop"
)

// The trusted host calls this only for an explicit owner confirmation of its
// retained account observation. Observation alone never approves an account.
// The private grant belongs to the original read owner, including exact follow-up;
// it cannot be selected for another admission by copying the returned receipt.
func (s *ComputerIngress) approveReadAccount(ctx context.Context, operation string, in wire.ChatReadIntentAccountApprove) (*wire.ChatReadIntentAccountApproved, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatReadIntentAccountApprove", in) != nil || in.ConfirmedPrincipalKey != in.Observation.PrincipalKey {
		return nil, readAccountRefusal("read_intent_account_invalid")
	}
	c, err := s.capturedRead(in.Admission)
	if err != nil {
		return nil, err
	}
	if c.withdrawn || c.accountRevoked {
		return nil, readAccountRefusal("read_intent_account_retired")
	}
	if c.accountReceipt != nil {
		if c.accountInput == nil || *c.accountInput != in {
			return nil, readAccountRefusal("read_intent_account_conflict")
		}
		out := *c.accountReceipt
		return &out, nil
	}
	if c.promoted != nil || c.account != nil {
		return nil, readAccountRefusal("read_intent_account_already_selected")
	}
	s.guard.mu.Lock()
	current := s.guard.active && !s.guard.exhausted && s.guard.revision == c.fence
	s.guard.mu.Unlock()
	if !current {
		return nil, readAccountRefusal("read_intent_authority_withdrawn")
	}
	b := c.binding
	clock := s.accountClock
	if clock == nil {
		clock = browserClock{}
	}
	owner, err := accountapproval.New(chatport.AccountScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID}, gate.New(), clock)
	if err != nil {
		return nil, err
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	if err = s.claim(operation); err != nil {
		return nil, err
	}
	observed, _ := strconv.ParseUint(in.Observation.ObservedAtMillis, 10, 64)
	expires, _ := strconv.ParseUint(in.Observation.ExpiresAtMillis, 10, 64)
	grant, err := owner.Approve(ctx, id, 0, chatport.AccountObservation{State: in.Observation.State, Source: in.Observation.Source, PrincipalKey: in.Observation.PrincipalKey, ObservedAtMillis: observed, ExpiresAtMillis: expires})
	if err != nil {
		// App policy errors here precede grant creation. The operation claim is
		// still consumed: a known refusal does not authorize automatic retry.
		var code accountapproval.Code
		if errors.As(err, &code) {
			return nil, readAccountRefusal(code)
		}
		return nil, err
	}
	c.accountOwner = owner
	c.account = &capturedChatAccount{grant: grant, approvalID: id}
	if ctx.Err() != nil {
		s.poison()
		return nil, errors.New("read_intent_account_unconfirmed")
	}
	// A concurrent authority withdrawal remains final. Do not publish a usable
	// receipt or replace the captured grant after a late outcome.
	s.guard.mu.Lock()
	current = s.guard.active && !s.guard.exhausted && s.guard.revision == c.fence
	s.guard.mu.Unlock()
	if !current {
		s.poison()
		return nil, errors.New("read_intent_account_unconfirmed")
	}
	out := wire.ChatReadIntentAccountApproved{Admission: in.Admission, ApprovalId: id, PrincipalKey: in.ConfirmedPrincipalKey}
	c.accountInput, c.accountReceipt = &in, &out
	reply := out
	return &reply, nil
}

func (s *ComputerIngress) revokeReadAccount(ctx context.Context, operation string, in wire.ChatReadIntentAccountRevoke) (*wire.ChatReadIntentWithdrawn, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatReadIntentAccountRevoke", in) != nil {
		return nil, readAccountRefusal("read_intent_account_invalid")
	}
	c, err := s.capturedRead(in.Admission)
	if err != nil {
		return nil, err
	}
	if c.accountOwner == nil || c.accountReceipt == nil || c.accountReceipt.ApprovalId != in.ApprovalId {
		return nil, readAccountRefusal("read_intent_account_not_owned")
	}
	if c.accountRevoked {
		return &wire.ChatReadIntentWithdrawn{Admission: in.Admission}, nil
	}
	if err = s.claim(operation); err != nil {
		return nil, err
	}
	// This one-shot owner has exactly one approval. Revoke cannot consult or
	// refresh a provider and remains available after expiry or queue admission.
	revision, err := c.accountOwner.Revoke(ctx, 1)
	if err != nil || revision != 2 || ctx.Err() != nil {
		s.poison()
		return nil, errors.New("read_intent_account_revoke_unconfirmed")
	}
	c.accountRevoked = true
	return &wire.ChatReadIntentWithdrawn{Admission: in.Admission}, nil
}

func (s *ComputerIngress) readAccountMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.readintent.account.approve": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatReadIntentAccountApprove
			if r.OperationID == "" || chatDecode("ChatReadIntentAccountApprove", r, &in) != nil {
				return invalidIngress()
			}
			v, err := s.approveReadAccount(ctx, r.OperationID, in)
			return readAccountOutcome("ChatReadIntentAccountApproved", v, err)
		}},
		"chat.readintent.account.revoke": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatReadIntentAccountRevoke
			if r.OperationID == "" || chatDecode("ChatReadIntentAccountRevoke", r, &in) != nil {
				return invalidIngress()
			}
			v, err := s.revokeReadAccount(ctx, r.OperationID, in)
			return readAccountOutcome("ChatReadIntentWithdrawn", v, err)
		}},
	}
}

// Only explicit known refusals are classified here. Post-grant cancellation,
// late withdrawal, poisoned ingress and unexpected errors remain unknown.
type readAccountRefusal string

func (e readAccountRefusal) Error() string { return string(e) }

func readAccountOutcome(shape string, value any, err error) (*desktop.Outcome, error) {
	var refusal readAccountRefusal
	if errors.As(err, &refusal) {
		return &desktop.Outcome{Status: "refused", Code: refusal.Error()}, nil
	}
	return chatOutcome(shape, value, err)
}

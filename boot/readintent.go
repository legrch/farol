package boot

import (
	"context"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
	admissionpeer "github.com/legrch/farol/modules/computer/infra/peer/admission"
	"github.com/legrch/farol/transport/desktop"
)

// An actual admitted owner is retained before Computer IO. Body IDs only select
// this captured capability after exact receipt comparison; they never create it.
type capturedReadIntent struct {
	owner          *conversation.ReadIntent
	binding        conversation.Binding
	fence          uint64
	admission      *wire.ChatComputerAdmissionResponse
	promoteInput   *wire.ChatReadIntentPromote
	promoted       *chatHandle
	route          *ComputerRoute
	withdrawn      bool
	access         computerport.AccessRepository
	seal           execution.Ceiling
	activation     *activationFence
	account        *capturedChatAccount
	accountOwner   *accountapproval.Service
	accountInput   *wire.ChatReadIntentAccountApprove
	accountReceipt *wire.ChatReadIntentAccountApproved
	accountRevoked bool
	modelInput     [32]byte
	modelCapture   *wire.ChatReadIntentResolved
}

// Caller holds effects across lookup and mutation. Publication, read admission,
// promotion and withdrawal therefore cannot replace each other's captured owner.
func (s *ComputerIngress) capturedRead(a wire.ChatComputerAdmissionResponse) (*capturedReadIntent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unknown || s.readFacade == nil || s.conversations == nil {
		return nil, errors.New("read_intent_unavailable")
	}
	c := s.readIntents[a.AdmissionOperationId]
	if c == nil || c.owner == nil || c.admission == nil || *c.admission != a {
		return nil, errors.New("read_intent_not_owned")
	}
	return c, nil
}

func (s *ComputerIngress) promoteRead(ctx context.Context, operation string, in wire.ChatReadIntentPromote) (*wire.ChatHandle, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatReadIntentPromote", in) != nil {
		return nil, errors.New("read_intent_invalid")
	}
	c, err := s.capturedRead(in.Admission)
	if err != nil {
		return nil, err
	}
	if c.promoted != nil {
		if c.promoteInput == nil || *c.promoteInput != in {
			return nil, errors.New("read_intent_conflict")
		}
		out := chatWireHandle(*c.promoted)
		return &out, nil
	}
	if c.account == nil || c.accountRevoked {
		return nil, errors.New("read_intent_account_not_approved")
	}
	if c.modelCapture == nil || c.modelCapture.Selection != in.Selection || c.modelCapture.Resolution != in.Resolution || c.modelCapture.Required != in.Required {
		return nil, readAccountRefusal("read_intent_selection_not_owned")
	}
	if err = s.claim(operation); err != nil {
		return nil, err
	}
	s.guard.mu.Lock()
	current := s.guard.active && !s.guard.exhausted && s.guard.revision == c.fence
	s.guard.mu.Unlock()
	if !current {
		return nil, errors.New("read_intent_authority_withdrawn")
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	h, err := s.readFacade.PromoteReadIntentAuthorized(ctx, c.owner, conversation.Input{
		Binding: c.binding, Prompt: in.Prompt, Selection: chatSelection(in.Selection), Resolution: chatResolution(in.Resolution),
		Required: conversation.RequiredControls{Model: in.Required.Model, Effort: in.Required.Effort, Mode: in.Required.Mode, Connector: in.Required.Connector},
	}, c)
	if err != nil || h == nil || ctx.Err() != nil {
		// An uncertain promotion is never repaired by a second admission, a
		// different host route or a fresh prompt. The owning service retains it.
		s.poison()
		return nil, errors.New("read_intent_promotion_unconfirmed")
	}
	owned := chatHandle{id: id, binding: c.binding, handle: h, beforeSend: c.checkDisclosure}
	s.conversations.mu.Lock()
	s.conversations.handles[id] = owned
	s.conversations.mu.Unlock()
	c.promoteInput, c.promoted = &in, &owned
	out := chatWireHandle(owned)
	return &out, nil
}

// Early refusal avoids dispatch IO when the captured route is already revoked.
// Authorize below independently checks the final physical disclosure boundary.
func (c *capturedReadIntent) checkDisclosure(ctx context.Context) error {
	if c == nil || c.route == nil || c.route.issuer == nil {
		return errors.New("read_intent_authority_unavailable")
	}
	lease, err := c.route.issuer.Admit(ctx, authority.Read)
	if err != nil {
		return err
	}
	b := c.binding
	expected := operationBinding(b.OwnerID, b.SessionID, b.TaskID, b.TaskEpoch, b.ParticipantID, b.TurnID)
	if lease.Binding() != expected {
		return errors.New("read_intent_authority_crossed")
	}
	return lease.WithSnapshot(ctx, b.ParticipantID, func(snapshot computerport.AccessSnapshot) error {
		if snapshot.Participant == nil || snapshot.Approval == nil {
			return errors.New("read_intent_authority_unavailable")
		}
		return nil
	})
}

// Authorize is required by the actual promoted Chat handle, including callers
// that bypass the ingress wrapper. The specialized current belongs to its exact
// known dispatch, not a positive ordinary admission reconstructed from IDs.
func (c *capturedReadIntent) Authorize(ctx context.Context, current *conversation.SendCurrent) error {
	if c == nil || c.access == nil || c.activation == nil || c.route == nil {
		return errors.New("read_intent_authority_unavailable")
	}
	peer, err := admissionpeer.NewChatSend(current)
	if err != nil {
		return err
	}
	var admitted computerport.CurrentTaskAdmission = peer
	if c.account != nil {
		admitted, err = c.account.forSend(ctx, current, c.binding, peer)
		if err != nil {
			return err
		}
	}
	guarded := &activatedAdmission{guard: c.activation, fence: c.fence, current: admitted}
	issuer, err := execution.New(c.access, guarded, c.route.clock, c.seal)
	if err != nil {
		return err
	}
	lease, err := issuer.Admit(ctx, authority.Read)
	if err != nil {
		return err
	}
	b := c.binding
	// The exact Chat capability supplies the current turn. Follow keeps the same
	// admitted task/participant ceiling but has a new turn and operation identity.
	// Never reconstruct a current turn from the original preview receipt.
	live := lease.Binding()
	if live.TurnID == "" || live != operationBinding(b.OwnerID, b.SessionID, b.TaskID, b.TaskEpoch, b.ParticipantID, live.TurnID) {
		return errors.New("read_intent_authority_crossed")
	}
	return lease.WithSnapshot(ctx, b.ParticipantID, func(snapshot computerport.AccessSnapshot) error {
		if snapshot.Participant == nil || snapshot.Approval == nil {
			return errors.New("read_intent_authority_unavailable")
		}
		return nil
	})
}

func (s *ComputerIngress) withdrawRead(ctx context.Context, operation string, in wire.ChatReadIntentWithdraw) (*wire.ChatReadIntentWithdrawn, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatReadIntentWithdraw", in) != nil {
		return nil, errors.New("read_intent_invalid")
	}
	c, err := s.capturedRead(in.Admission)
	if err != nil {
		return nil, err
	}
	if c.promoted != nil {
		return nil, errors.New("read_intent_already_promoted")
	}
	if c.withdrawn {
		return &wire.ChatReadIntentWithdrawn{Admission: *c.admission}, nil
	}
	if err = s.claim(operation); err != nil {
		return nil, err
	}
	if err = s.readFacade.WithdrawReadIntent(ctx, c.owner); err != nil || ctx.Err() != nil {
		s.poison()
		return nil, errors.New("read_intent_withdrawal_unconfirmed")
	}
	c.withdrawn = true
	return &wire.ChatReadIntentWithdrawn{Admission: *c.admission}, nil
}

func (s *ComputerIngress) readIntentMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.readintent.resolve": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatReadIntentResolve
			if r.OperationID == "" || chatDecode("ChatReadIntentResolve", r, &in) != nil {
				return invalidIngress()
			}
			v, e := s.resolveRead(ctx, r.OperationID, in)
			return readAccountOutcome("ChatReadIntentResolved", v, e)
		}},
		"chat.readintent.promote": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatReadIntentPromote
			if r.OperationID == "" || chatDecode("ChatReadIntentPromote", r, &in) != nil {
				return invalidIngress()
			}
			v, e := s.promoteRead(ctx, r.OperationID, in)
			return readAccountOutcome("ChatHandle", v, e)
		}},
		"chat.readintent.withdraw": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatReadIntentWithdraw
			if r.OperationID == "" || chatDecode("ChatReadIntentWithdraw", r, &in) != nil {
				return invalidIngress()
			}
			v, e := s.withdrawRead(ctx, r.OperationID, in)
			return chatOutcome("ChatReadIntentWithdrawn", v, e)
		}},
	}
}

package lifecycle

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/output"
)

// Retention IO occurs outside the owner gate. A durable store must supply a
// publication at the same physical Chat root. Late/lost replies are fenced in
// both owners; no reload or compensating Retain can make the outcome known.
func (s *Service) retainResult(ctx context.Context, m *mutation, request port.RetainRequest) error {
	durable, persistent := s.deps.Results.(port.DurableResults)
	receipt, err := s.deps.Results.Retain(ctx, request)
	s.deps.Gate.Lock()
	current := s.current(ctx, m)
	valid := err == nil && receipt != nil && receipt.Binding == request.Binding && receipt.Result == request.Result && receipt.Bytes == len(request.Payload) && receipt.Conversation == request.Conversation
	if valid {
		p := receipt.Publication
		valid = (!persistent && p == (port.ResultPublication{})) || (persistent && p.Valid() && p.Root == s.root)
	}
	if current != nil || !valid {
		s.unknown = true
		s.deps.Gate.Unlock()
		if persistent {
			// This is the separate one-shot uncertainty marker, not a retry of
			// the original publication. Its failure never restores permission.
			_ = durable.Fence(context.WithoutCancel(ctx))
		}
		if current != nil {
			return current
		}
		return Unsettled
	}
	copy := *receipt
	m.retained = &copy
	s.deps.Gate.Unlock()
	return nil
}

// Called under the owner gate with the exact staged output, before terminal
// publication. It excludes prompts, frame history and reusable Send witnesses.
func retainedConversation(h *Handle, state output.State) port.RetainedConversation {
	if h.conversation == nil {
		return port.RetainedConversation{}
	}
	return port.RetainedConversation{
		ProviderConversationID: h.conversation.providerID,
		ProviderUserTurnID:     state.UserID, ProviderReplyID: state.ReplyID,
		Requested: h.target.Selection, Observed: h.verification.Observed.Projection(),
		Evidence: selectionEvidence(h), Complete: state.Complete,
	}
}

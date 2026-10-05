package lifecycle

import (
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/output"
)

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

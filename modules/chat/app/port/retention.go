package port

import (
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/domain/turn"
)

// RetainedConversation is immutable terminal delivery metadata. Binding,
// result identity/outcome and payload stay in the enclosing retention request.
// The zero value denotes a non-conversation result. It is not a conversation
// handle, current admission, reusable Send verification or delivery ACK.
type RetainedConversation struct {
	ProviderConversationID, ProviderUserTurnID, ProviderReplyID string
	Requested                                                   Selection
	Observed                                                    SelectionFacts
	Evidence                                                    SelectionEvidence
	Complete                                                    bool
}

// Valid checks bounded, internally consistent historical values. It supplies
// no present account, connector or caller authority. Generic result payloads
// keep their original byte semantics; conversation output is UTF-8 text.
func (r RetainedConversation) Valid(result turn.Result, payload []byte) bool {
	if r == (RetainedConversation{}) {
		return true
	}
	if !r.Requested.Valid() || !utf8.Valid(payload) || r.Evidence.Requested != r.Requested ||
		r.Evidence.Observed != r.Observed || r.Observed.Projection() != r.Observed ||
		!r.Evidence.Resolution.Valid(r.Requested) || r.Evidence.PinnedSource != "configured-pinned-scope" {
		return false
	}
	for _, id := range []string{r.ProviderConversationID, r.ProviderUserTurnID, r.ProviderReplyID} {
		if id != "" && !conversationID(id) {
			return false
		}
	}
	if (r.ProviderUserTurnID != "" && r.ProviderConversationID == "") || (r.ProviderReplyID != "" && r.ProviderUserTurnID == "") {
		return false
	}
	if r.Complete != (result.Outcome == turn.Completed) || (r.Complete && (r.ProviderConversationID == "" || r.ProviderUserTurnID == "" || r.ProviderReplyID == "")) {
		return false
	}
	resolutionSource := "unknown"
	if r.Evidence.Resolution != (ModelResolution{}) {
		resolutionSource = "configured"
	}
	if r.Evidence.ResolutionSource != resolutionSource {
		return false
	}
	if r.Evidence.AdmissionSource == "unknown" {
		return r.Evidence.Admitted == (Selection{}) && r.Evidence.EvidenceID == "" && r.Evidence.ObservationSource == "unknown" && r.Observed == (SelectionFacts{}).Projection()
	}
	return r.Evidence.AdmissionSource == "chat-policy" && r.Evidence.Admitted == r.Requested &&
		r.Evidence.ObservationSource == "field-facts" && conversationID(r.Evidence.EvidenceID) &&
		r.Observed.Matches(r.Requested, RequiredControls{Model: true, Mode: r.Requested.Mode != "", Connector: r.Requested.ToolsEnabled})
}

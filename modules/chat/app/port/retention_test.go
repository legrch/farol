package port

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/domain/turn"
)

func retainedFixture() RetainedConversation {
	s := Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "low"}
	f := SelectionFacts{Model: ControlFact{Value: "model", Literal: "Model", Source: FactPublicControl}, ObservedAtMillis: 1}.Projection()
	return RetainedConversation{ProviderConversationID: "conversation", ProviderUserTurnID: "user", ProviderReplyID: "reply", Requested: s, Observed: f, Complete: true,
		Evidence: SelectionEvidence{Requested: s, Admitted: s, Observed: f, ResolutionSource: "unknown", AdmissionSource: "chat-policy", ObservationSource: "field-facts", PinnedSource: "configured-pinned-scope", EvidenceID: "evidence"}}
}

func TestRetainedConversationRejectsUnboundedOrContradictoryHistory(t *testing.T) {
	result := turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}
	if !retainedFixture().Valid(result, []byte("answer")) {
		t.Fatal("valid historical delivery refused")
	}
	for name, change := range map[string]func(*RetainedConversation){
		"incomplete":              func(r *RetainedConversation) { r.Complete = false },
		"missing-conversation":    func(r *RetainedConversation) { r.ProviderConversationID = "" },
		"missing-user":            func(r *RetainedConversation) { r.ProviderUserTurnID = "" },
		"missing-reply":           func(r *RetainedConversation) { r.ProviderReplyID = "" },
		"long-id":                 func(r *RetainedConversation) { r.ProviderReplyID = strings.Repeat("x", 121) },
		"private-id":              func(r *RetainedConversation) { r.ProviderUserTurnID = "private prose" },
		"selection":               func(r *RetainedConversation) { r.Requested.AccountID = "other" },
		"observed":                func(r *RetainedConversation) { r.Observed.Model.Value = "other" },
		"invented-resolution":     func(r *RetainedConversation) { r.Evidence.ResolutionSource = "configured" },
		"invented-admission":      func(r *RetainedConversation) { r.Evidence.AdmissionSource = "provider-verified" },
		"missing-evidence":        func(r *RetainedConversation) { r.Evidence.EvidenceID = "" },
		"unknown-fact-with-value": func(r *RetainedConversation) { r.Observed.Model.Source = FactUnknown; r.Evidence.Observed = r.Observed },
		"long-literal": func(r *RetainedConversation) {
			r.Observed.Model.Literal = strings.Repeat("x", 257)
			r.Evidence.Observed = r.Observed
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := retainedFixture()
			change(&r)
			if r.Valid(result, []byte("answer")) {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
	if retainedFixture().Valid(result, []byte{255}) {
		t.Fatal("invalid conversation UTF-8 accepted")
	}
	if !(RetainedConversation{}).Valid(result, []byte{0, 255}) {
		t.Fatal("generic byte semantics changed")
	}
}

func TestRetainedConversationKnownNotSentHasNoInventedIdentity(t *testing.T) {
	r := retainedFixture()
	r.Complete = false
	r.ProviderConversationID, r.ProviderUserTurnID, r.ProviderReplyID = "", "", ""
	result := turn.Result{ID: "result", Outcome: turn.Failed, Code: "SEND_NOT_SENT"}
	if !r.Valid(result, nil) {
		t.Fatal("verified not-sent metadata refused")
	}
	r.Evidence = SelectionEvidence{Requested: r.Requested, ResolutionSource: "unknown", AdmissionSource: "unknown", ObservationSource: "unknown", PinnedSource: "configured-pinned-scope", Observed: (SelectionFacts{}).Projection()}
	r.Observed = r.Evidence.Observed
	if !r.Valid(result, nil) {
		t.Fatal("unverified historical metadata refused")
	}
	r.ProviderReplyID = "invented"
	if r.Valid(result, nil) {
		t.Fatal("reply without a user accepted")
	}
}

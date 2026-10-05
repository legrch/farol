package results

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func TestMemoryRetainsAndComparesCompleteConversationMetadata(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := requestFixture()
	s := port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "low"}
	f := (port.SelectionFacts{Model: port.ControlFact{Value: "model", Literal: "Model", Source: port.FactPublicControl}, ObservedAtMillis: 1}).Projection()
	r.Conversation = port.RetainedConversation{ProviderConversationID: "conversation", ProviderUserTurnID: "user", ProviderReplyID: "reply", Requested: s, Observed: f, Complete: true,
		Evidence: port.SelectionEvidence{Requested: s, Admitted: s, Observed: f, ResolutionSource: "unknown", AdmissionSource: "chat-policy", ObservationSource: "field-facts", PinnedSource: "configured-pinned-scope", EvidenceID: "evidence"}}
	m, err := NewMemory(ctx, port.JournalScope{ProfileID: r.Binding.ProfileID, BackendGeneration: r.Binding.BackendGeneration}, TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	first, err := m.Retain(ctx, r)
	if err != nil || first.Conversation != r.Conversation {
		t.Fatal("metadata not retained", err)
	}
	first.Conversation.ProviderReplyID = "mutated-return"
	again, err := m.Retain(ctx, r)
	if err != nil || again.Conversation != r.Conversation {
		t.Fatal("returned receipt aliases store", err)
	}
	for _, mutate := range []func(*port.RetainRequest){
		func(x *port.RetainRequest) { x.Conversation.ProviderReplyID = "changed-reply" },
		func(x *port.RetainRequest) { x.Conversation.Evidence.EvidenceID = "changed-evidence" },
		func(x *port.RetainRequest) { x.Conversation = port.RetainedConversation{} },
	} {
		changed := r
		mutate(&changed)
		if _, err := m.Retain(ctx, changed); !errors.Is(err, Conflict) {
			t.Fatal("changed metadata reused exact receipt", err)
		}
	}
	changed := r
	changed.Binding.OperationID = "new-result"
	changed.Conversation.Complete = false
	if _, err := m.Retain(ctx, changed); !errors.Is(err, Invalid) {
		t.Fatal("invalid metadata retained", err)
	}
	if len(m.entries) != 1 {
		t.Fatal("refusal changed store")
	}
}

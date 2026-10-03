package turn

import "testing"

func TestOneHomeAcceptanceAdoptsCIDWithoutChangingPhysicalIdentity(t *testing.T) {
	v, b := prepared(t)
	v.binding.Document.ProviderState = ProviderHome
	v.binding.Document.ConversationID = ""
	b = v.binding
	v, err := v.Dispatch(b)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Accept(b); err == nil {
		t.Fatal("unproven Home accepted")
	}
	bad := b
	bad.Document.DocumentGeneration++
	if next, err := v.AcceptConversation(bad, "real-cid"); err == nil || next != v {
		t.Fatal("stale scope adopted")
	}
	adopted, err := v.AcceptConversation(b, "real-cid")
	if err != nil {
		t.Fatal(err)
	}
	if adopted.binding.Reservation != b.Reservation || adopted.binding.Document.ViewID != b.Document.ViewID || adopted.binding.Document.DocumentGeneration != b.Document.DocumentGeneration || adopted.binding.Document.ConversationID != "real-cid" || !adopted.accepted {
		t.Fatal("incorrect adoption")
	}
	if next, err := adopted.AcceptConversation(adopted.binding, "different-cid"); err == nil || next != adopted {
		t.Fatal("second adoption changed history")
	}
	if _, err := adopted.Dispatch(adopted.binding); err == nil {
		t.Fatal("adoption reopened Send")
	}
	for _, d := range []Document{{ProviderState: ProviderHome, ViewID: "v", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "fake"}, {ProviderState: ProviderBound, ViewID: "v", ViewGeneration: 1, DocumentGeneration: 1}, {ProviderState: "fake", ViewID: "v", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "real"}} {
		if d.valid() {
			t.Fatal("invalid provider state accepted")
		}
	}
}

package task

import "testing"

func TestProviderSemanticsStayDistinct(t *testing.T) {
	caps := Capabilities{Create: true, Continue: true, Resume: true, Message: true, Cancel: true}
	for _, p := range []Provider{Codex, Claude} {
		ref := Reference{ThreadID: "thread", TurnID: "turn"}
		if p == Claude {
			ref = Reference{SessionID: "session", InvocationID: "invocation"}
		}
		value := Task{Binding: Binding{Provider: p}, Reference: ref, Lifecycle: Completed}
		if value.Allows(Continue, caps) != (p == Codex) || value.Allows(Resume, caps) != (p == Claude) || value.Allows(Message, caps) {
			t.Fatal(p)
		}
		value.Lifecycle = Running
		if !value.Allows(Message, caps) || value.Allows(Resume, caps) || value.Allows(Continue, caps) {
			t.Fatal(p)
		}
		value.CancelRequested = true
		if value.Allows(Cancel, caps) {
			t.Fatal("duplicate cancel")
		}
	}
}
func TestLineageOnlyExtendsSameIdentity(t *testing.T) {
	r := Reference{ThreadID: "thread"}
	if !r.Extend(Reference{ThreadID: "thread", TurnID: "turn"}, Codex) || r.Extend(Reference{ThreadID: "foreign"}, Codex) || r.Extend(Reference{SessionID: "session"}, Codex) {
		t.Fatal("lineage accepted foreign binding")
	}
}
func TestUnknownAndNeedsInputDoNotAuthorizeContinuation(t *testing.T) {
	for _, state := range []Lifecycle{Unknown, NeedsInput, Refused} {
		value := Task{Binding: Binding{Provider: Codex}, Reference: Reference{ThreadID: "thread", TurnID: "turn"}, Lifecycle: state}
		if value.Allows(Continue, Capabilities{Continue: true}) {
			t.Fatal(state)
		}
	}
}

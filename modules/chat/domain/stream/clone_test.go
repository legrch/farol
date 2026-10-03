package stream

import "testing"

func TestCandidateCloneCannotPublishFramesOrACKToOriginal(t *testing.T) {
	scope := Scope{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TurnID: "turn", TurnGeneration: 1}
	original, err := New(scope, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := original.Append(Delta, []byte("one")); err != nil {
		t.Fatal(err)
	}
	candidate := original.Clone()
	if _, err := candidate.Acknowledge(scope, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := candidate.Append(Terminal, []byte("done")); err != nil {
		t.Fatal(err)
	}
	if original.Snapshot().Terminal || original.Snapshot().LastSequence != 1 || original.frames[0].acknowledged {
		t.Fatal("candidate mutated original")
	}
	candidate.frames[0].frame.Data[0] = 'X'
	frames, err := original.Replay(scope)
	if err != nil || string(frames[0].Data) != "one" {
		t.Fatal("candidate shared content bytes")
	}
}

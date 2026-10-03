package lifecycle

import (
	"context"
	"errors"
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"testing"
)

func TestHomeProviderIdentityIsAdoptedOnlyAfterKnownAcceptedCommit(t *testing.T) {
	s, b, j, _ := conversationOwner(t)
	ctx := context.Background()
	c, binding := createPrepared(t, s)
	if binding.ProviderState != port.ProviderHome || binding.ConversationID != "" || c.providerID != "" || len(s.providerOwners) != 0 {
		t.Fatal("pre-Send manufactured provider identity")
	}
	b.events = observations("first-user", "first-reply", "text")
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if c.providerID != "" || len(s.providerOwners) != 0 {
		t.Fatal("submitted became bound provider identity")
	}
	observeOK(t, c)
	if c.providerID != "fixture-conversation" || s.providerOwners[c.providerID] != c.handle.fixed {
		t.Fatal("accepted CID not owned")
	}
	var state port.CurrentTurn
	if err := c.handle.WithCurrent(ctx, func(v *port.CurrentTurn) error { state = *v; return nil }); err != nil {
		t.Fatal(err)
	}
	old := turn.Document{ProviderState: turn.ProviderHome, ViewID: binding.ViewID, ViewGeneration: binding.ViewGeneration, DocumentGeneration: binding.DocumentGeneration}
	d := state.Turn.Binding.Document
	if d.ProviderState != turn.ProviderBound || d.ConversationID != c.providerID || d.ViewID != old.ViewID || d.ViewGeneration != old.ViewGeneration || d.DocumentGeneration != old.DocumentGeneration {
		t.Fatal("adoption changed physical scope")
	}
	if j.writes[len(j.writes)-1].Entry.Kind != "accept" || j.writes[len(j.writes)-1].Entry.Before.Binding.Document.ConversationID != "" || j.writes[len(j.writes)-1].Entry.After.Binding.Document.ConversationID != c.providerID {
		t.Fatal("CID adoption not journaled in accepted transition")
	}
	if result, err := c.Result(ctx); result != nil || err == nil {
		t.Fatal("acceptance fabricated terminal delivery")
	}
	for n := 0; n < 3; n++ {
		observeOK(t, c)
	}
	result, err := c.Result(ctx)
	if err != nil || !result.Complete {
		t.Fatal(err)
	}
	if _, err := s.FollowConversation(ctx, c, followInput()); err == nil {
		t.Fatal("follow without real ACK")
	}
	if err := c.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	next, err := s.FollowConversation(ctx, c, followInput())
	if err != nil || next.target.Mode != port.OwnedSaved || next.target.ConversationID != c.providerID {
		t.Fatal("bound followup missing", err)
	}
	if len(b.sent) != 1 {
		t.Fatal("extra Send")
	}
}
func TestAcceptedIdentityFailuresCannotPublishProviderOwnership(t *testing.T) {
	for _, fault := range []string{"collision", "document", "journal", "missing-cid"} {
		t.Run(fault, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.events = observations("u", "r", "text")
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "collision":
				s.providerOwners["fixture-conversation"] = route("other")
			case "document":
				b.observeFault = "binding"
			case "journal":
				j.fault = "error"
			case "missing-cid":
				b.events[0].Kind = port.AnswerDelta
				b.events[0].ReplyID = "r"
				b.events[0].SegmentID = "s"
				b.events[0].Text = "text"
			}
			if err := c.Observe(context.Background(), 100); !errors.Is(err, Unsettled) {
				t.Fatal("false accepted result", err)
			}
			if c.providerID != "" || s.providerOwners["fixture-conversation"] == c.handle.fixed {
				t.Fatal("failure published ownership")
			}
			if err := c.Send(context.Background(), 100); err == nil || len(b.sent) != 1 {
				t.Fatal("failure retried Send")
			}
		})
	}
}
func TestUnknownRequiredControlsAndPinnedEchoCannotDispatch(t *testing.T) {
	cases := map[string]func(*port.SendVerification){
		"echo-only":         func(v *port.SendVerification) { v.Observed = port.SelectionFacts{} },
		"model-unknown":     func(v *port.SendVerification) { v.Observed.Model = port.ControlFact{} },
		"effort-unknown":    func(v *port.SendVerification) { v.Observed.Effort = port.ControlFact{} },
		"connector-unknown": func(v *port.SendVerification) { v.Observed.Connector = port.ControlFact{} },
		"policy-change":     func(v *port.SendVerification) { v.Required.Effort = false },
		"configured-source": func(v *port.SendVerification) { v.Observed.Model.Source = "configured" },
		"missing-literal":   func(v *port.SendVerification) { v.Observed.Model.Literal = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			s, b, _, _ := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.verifyHook = mutate
			if err := c.Send(context.Background(), 100); err == nil || len(b.sent) != 0 {
				t.Fatal("unproven selector dispatched", err)
			}
		})
	}
}
func TestDeclaredCapabilityKeepsUnavailableEffortUnknownAndPolicyImmutable(t *testing.T) {
	// This fixture selects a route whose declared capability has no effort control.
	// Required flags are fixed BEFORE admission, never lowered to rescue a failed proof.
	s, b, _, _ := conversationOwner(t)
	ctx := context.Background()
	i := input("1")
	i.Required.Effort = false
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	changed := i
	changed.Required.Effort = true
	if _, err := s.CreateConversation(ctx, changed); err != turn.Conflict {
		t.Fatal("queued capability policy replaced", err)
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	b.verifyHook = func(v *port.SendVerification) { v.Observed.Effort = port.ControlFact{} }
	if err := c.Send(ctx, 100); err != nil || len(b.sent) != 1 {
		t.Fatal("declared capability refused", err)
	}
	if err := c.WithConversation(ctx, func(v port.ConversationState) error {
		if v.Evidence.Observed.Effort.Source != port.FactUnknown || v.Evidence.Observed.Effort.Value != "" || v.Evidence.Requested.Effort != "low" || v.Evidence.PinnedSource != "configured-pinned-scope" {
			t.Fatal("configured effort became observed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

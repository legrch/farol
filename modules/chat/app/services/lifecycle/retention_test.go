package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

func TestConversationRetentionUsesStagedTerminalState(t *testing.T) {
	s, b, _, retained := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("original-user", "original-reply", "Exact retained answer.")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	var captured port.RetainRequest
	retained.hook = func(r port.RetainRequest) {
		// The previous live projection is deliberately incomplete until the
		// terminal journal publication succeeds. Retention must use its candidate.
		if c.handle.output.Complete {
			t.Fatal("terminal state exposed before retention")
		}
		captured = r
	}
	observeOK(t, c)
	result, err := c.Result(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := captured.Conversation
	if captured.Binding != result.Binding || captured.Result.ID != result.ResultID || string(captured.Payload) != result.Text ||
		m.ProviderConversationID != result.ProviderConversationID || m.ProviderUserTurnID != "original-user" || m.ProviderReplyID != "original-reply" ||
		m.Requested != result.Requested || m.Observed != result.Observed || m.Evidence != result.Evidence || !m.Complete || !result.Complete {
		t.Fatal("retained terminal envelope differs from committed result")
	}
	if retained.calls != 1 || len(b.sent) != 1 {
		t.Fatal("retention caused extra work")
	}
}

func TestNotSentRetentionMetadataMismatchRemainsFenced(t *testing.T) {
	s, b, j, retained := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.sendReplyFault = "not-sent"
	retained.fault = "conversation-missing"
	if err := c.Send(context.Background(), 100); !errors.Is(err, Unsettled) {
		t.Fatal("mismatched not-sent metadata accepted", err)
	}
	writes := j.count()
	if _, err := c.Result(context.Background()); !errors.Is(err, Unsettled) {
		t.Fatal("uncertain not-sent retention became readable", err)
	}
	if err := c.Send(context.Background(), 100); !errors.Is(err, Unsettled) || j.count() != writes || retained.calls != 1 || len(b.sent) != 1 {
		t.Fatal("not-sent uncertainty allowed another effect", err)
	}
}

func TestConversationRetentionPreservesPartialFailureMetadata(t *testing.T) {
	for _, terminal := range []struct {
		kind    port.ObservationKind
		outcome turn.Outcome
	}{
		{port.Refused, turn.Refused}, {port.OutcomeUnknown, turn.UnknownOutcome},
	} {
		t.Run(string(terminal.kind), func(t *testing.T) {
			s, b, _, retained := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.events = observations("user", "reply", "partial output")
			b.events[2].Kind = terminal.kind
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			observeOK(t, c)
			observeOK(t, c)
			var captured port.RetainRequest
			retained.hook = func(r port.RetainRequest) { captured = r }
			observeOK(t, c)
			m := captured.Conversation
			if captured.Result.Outcome != terminal.outcome || string(captured.Payload) != "partial output" ||
				m.ProviderConversationID != "fixture-conversation" || m.ProviderUserTurnID != "user" || m.ProviderReplyID != "reply" || m.Complete ||
				m.Requested != selected() || m.Evidence.EvidenceID == "" || !m.Valid(captured.Result, captured.Payload) {
				t.Fatal("partial failure was lost or upgraded to complete")
			}
		})
	}
}

func TestConversationRetentionMetadataMismatchFencesTerminal(t *testing.T) {
	for _, fault := range []string{"conversation", "conversation-missing"} {
		t.Run(fault, func(t *testing.T) {
			s, b, j, retained := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.events = observations("user", "reply", "answer")
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			observeOK(t, c)
			observeOK(t, c)
			writes := j.count()
			retained.fault = fault
			if err := c.Observe(context.Background(), 100); !errors.Is(err, Unsettled) {
				t.Fatalf("mismatched retention became terminal: %v", err)
			}
			if _, err := c.Result(context.Background()); !errors.Is(err, Unsettled) {
				t.Fatalf("uncertain result became readable: %v", err)
			}
			if err := c.Observe(context.Background(), 100); !errors.Is(err, Unsettled) || retained.calls != 1 || j.count() != writes || len(b.sent) != 1 {
				t.Fatal("uncertain retention was retried or journaled")
			}
		})
	}
}

func TestNotSentRetentionKeepsSelectionWithoutInventingProviderTurns(t *testing.T) {
	s, b, _, retained := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.sendReplyFault = "not-sent"
	var captured port.RetainRequest
	retained.hook = func(r port.RetainRequest) { captured = r }
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	result, err := c.Result(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := captured.Conversation
	if m.Requested != selected() || m.Evidence != result.Evidence || m.Observed != result.Observed ||
		m.ProviderConversationID != "" || m.ProviderUserTurnID != "" || m.ProviderReplyID != "" || m.Complete || len(captured.Payload) != 0 {
		t.Fatal("known not-sent metadata lost or fabricated")
	}
}

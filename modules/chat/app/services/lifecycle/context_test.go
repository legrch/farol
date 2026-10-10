package lifecycle

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Real original Chat lifecycle, queue, journal CAS and output owner; browser and
// disk/provider effects are controlled ports, not live/native qualification.
func TestContextSourcePreservesOriginalPromptAfterSend(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	first, next := completedFirst(t, s, b)
	if first.handle.prompt != "" || first.input.Prompt != "" {
		t.Fatal("dispatch input must still be cleared")
	}
	lease, err := first.CaptureContext(context.Background())
	if err != nil {
		t.Fatalf("original completed source: %v", err)
	}
	if err := lease.WithCurrent(context.Background(), func(source ContextSnapshot) error {
		if len(source.Turns) != 1 || source.Turns[0].Prompt != input("1").Prompt || source.Turns[0].Text != "pear" || !source.Turns[0].Complete || source.Turns[0].Binding != input("1").Binding {
			t.Fatalf("lost original exchange: %+v", source)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	second, err := s.FollowConversation(context.Background(), first, next)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.WithCurrent(context.Background(), func(ContextSnapshot) error { t.Fatal("old lease exposed late follow"); return nil }); err == nil {
		t.Fatal("old revision remained current")
	}
	latest, err := second.CaptureContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := latest.WithCurrent(context.Background(), func(source ContextSnapshot) error {
		if len(source.Turns) != 2 || source.Turns[0].Prompt != input("1").Prompt || source.Turns[1].Prompt != next.Prompt || source.Turns[1].Complete {
			t.Fatal("wrong exact original chain")
		}
		source.Turns[0].Prompt = "edited detached source"
		source.Turns = nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := latest.WithCurrent(context.Background(), func(source ContextSnapshot) error {
		if source.Turns[0].Prompt != input("1").Prompt {
			t.Fatal("callback changed owner")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
func TestContextSourcePreservesPromotedOriginal(t *testing.T) {
	s, _, _, _ := conversationOwner(t)
	i := input("1")
	h, err := s.Admit(context.Background(), i.Binding, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.PromoteConversation(context.Background(), h, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PrepareNext(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if err = c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	// A sent but incomplete exchange must not become a complete context source.
	if _, err = c.CaptureContext(context.Background()); !errors.Is(err, SourceIncomplete) {
		t.Fatalf("partial source: %v", err)
	}
}
func TestContextSourceOriginalLeaseRefusals(t *testing.T) {
	for _, name := range []string{"unknown", "pending", "frozen", "retiring", "observing", "caller", "missing-original", "cancelled-context"} {
		t.Run(name, func(t *testing.T) {
			s, _, _, _ := conversationOwner(t)
			c, err := s.CreateConversation(context.Background(), input("1"))
			if err != nil {
				t.Fatal(err)
			}
			lease, err := c.CaptureContext(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			s.deps.Gate.Lock()
			switch name {
			case "unknown":
				s.unknown = true
			case "pending":
				s.pending = &mutation{}
			case "frozen":
				s.frozen = true
			case "retiring":
				s.retiring = true
			case "observing":
				c.handle.observing = true
			case "caller":
				c.handle.caller = &CallerToolCall{}
			case "missing-original":
				c.handle.contextPrompt = ""
			case "cancelled-context":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			s.deps.Gate.Unlock()
			calls := 0
			if err = lease.WithCurrent(ctx, func(ContextSnapshot) error { calls++; return nil }); err == nil || calls != 0 {
				t.Fatalf("unsafe exposure %s: %v / %d", name, err, calls)
			}
		})
	}
}

func TestContextSourceResolvedToolRoundRemainsIncomplete(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "answer")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	view, err := s.queue.Snapshot(identity(c.handle.fixed))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Apply(context.Background(), c.handle, Change{Action: RequestComputer, Binding: view.Binding, CallID: "original-tool-operation"}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Apply(context.Background(), c.handle, Change{Action: ResolveComputer, Binding: view.Binding, CallID: "original-tool-operation"}); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	if c.handle.unresolvedCallID != "" || c.handle.caller != nil {
		t.Fatal("control must have no surviving tool body")
	}
	if _, err = c.CaptureContext(context.Background()); !errors.Is(err, SourceIncomplete) {
		t.Fatalf("resolved tool was silently omitted: %v", err)
	}
}
func TestContextSourcePromotedCompletedOriginal(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	i := input("1")
	h, err := s.Admit(context.Background(), i.Binding, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.PromoteConversation(context.Background(), h, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PrepareNext(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	b.events = observations("user-1", "reply-1", "actual promoted reply")
	if err = c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	if h.prompt != "" {
		t.Fatal("one-shot input wasn't cleared")
	}
	lease, err := c.CaptureContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = lease.WithCurrent(context.Background(), func(source ContextSnapshot) error {
		if source.Turns[0].Prompt != i.Prompt || source.Turns[0].Text != "actual promoted reply" {
			t.Fatal("lost promoted originals")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

type sendAuthorizationFunc func(context.Context, port.SendCurrent) error

func (f sendAuthorizationFunc) Authorize(ctx context.Context, c port.SendCurrent) error {
	return f(ctx, c)
}

func TestSendAuthorizationIsScopedToFinalKnownDispatch(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	h, i := admit(t, s, "1"), input("1")
	ctx := context.Background()
	var retained port.SendCurrent
	authorize := sendAuthorizationFunc(func(ctx context.Context, current port.SendCurrent) error {
		retained = current
		if len(b.verifies) != 1 || len(b.sent) != 0 {
			t.Fatal("authorization outside final boundary")
		}
		if err := h.WithCurrent(ctx, func(value *port.CurrentTurn) error {
			if value == nil || value.Persistence != port.PendingCommit {
				t.Fatal("ordinary admission upgraded while dispatch pending")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return current.WithCurrent(ctx, func(binding port.TurnBinding) error {
			if binding != h.fixed {
				t.Fatal("crossed dispatch owner")
			}
			return nil
		})
	})
	c, err := s.PromoteConversationAuthorized(ctx, h, i, authorize)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, 100); err != nil || len(b.sent) != 1 || b.sent[0].Prompt != i.Prompt {
		t.Fatal("authorized Send", err)
	}
	called := false
	if err := retained.WithCurrent(ctx, func(port.TurnBinding) error { called = true; return nil }); !errors.Is(err, Unavailable) || called {
		t.Fatal("dispatch capability survived callback", err)
	}
	if err := h.WithCurrent(ctx, func(value *port.CurrentTurn) error {
		if value == nil || value.Persistence != port.Committed {
			t.Fatal("stale capability changed current projection")
		}
		return nil
	}); err != nil {
		t.Fatal("stale capability poisoned current owner", err)
	}
}

func TestSendAuthorizationCannotSkipOrLoseItsCurrentCallback(t *testing.T) {
	for _, kind := range []string{"skip", "refuse", "late-refusal"} {
		t.Run(kind, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			h, i := admit(t, s, "1"), input("1")
			ctx := context.Background()
			a := sendAuthorizationFunc(func(ctx context.Context, c port.SendCurrent) error {
				if kind == "skip" {
					return nil
				}
				if kind == "refuse" {
					return Unavailable
				}
				if err := c.WithCurrent(ctx, func(port.TurnBinding) error { return nil }); err != nil {
					return err
				}
				// A broken consumer cannot hide a later refused inspection behind
				// an earlier positive callback and still disclose bytes.
				_ = c.WithCurrent(ctx, func(port.TurnBinding) error { return Unavailable })
				return nil
			})
			c, err := s.PromoteConversationAuthorized(ctx, h, i, a)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			if err = c.Send(ctx, 100); err != nil || len(b.sent) != 0 {
				t.Fatal("unauthorized Send", err)
			}
			result, err := c.Result(ctx)
			if err != nil || result.Code != "SEND_NOT_SENT" || result.Outcome != "failed" {
				t.Fatal("known refusal missing", result, err)
			}
			count := j.count()
			if err = c.Send(ctx, 100); err == nil || len(b.sent) != 0 || j.count() != count {
				t.Fatal("refusal retried", err)
			}
		})
	}
}

package lifecycle

import (
	"context"
	"errors"
	"strings"
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
	for _, kind := range []string{"skip", "account-snapshot-only", "refuse", "late-refusal"} {
		t.Run(kind, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			h, i := admit(t, s, "1"), input("1")
			ctx := context.Background()
			a := sendAuthorizationFunc(func(ctx context.Context, c port.SendCurrent) error {
				if kind == "account-snapshot-only" {
					_, err := c.AccountSnapshot(ctx)
					return err
				}
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

func TestSendAuthorizationAccountSnapshotIsExactDetachedAndExpires(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	h, i := admit(t, s, "1"), input("1")
	ctx := context.Background()
	account := port.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("c", 64), ObservedAtMillis: 1, ExpiresAtMillis: 100}
	b.verifyHook = func(v *port.SendVerification) { v.Account = account }
	var retained port.SendCurrent
	a := sendAuthorizationFunc(func(ctx context.Context, current port.SendCurrent) error {
		retained = current
		snapshot, err := current.AccountSnapshot(ctx)
		if err != nil || snapshot != account {
			t.Fatal("missing exact snapshot", err)
		}
		snapshot.PrincipalKey = strings.Repeat("d", 64)
		again, err := current.AccountSnapshot(ctx)
		if err != nil || again != account {
			t.Fatal("mutable snapshot escaped", err)
		}
		return current.WithCurrent(ctx, func(port.TurnBinding) error { return nil })
	})
	c, err := s.PromoteConversationAuthorized(ctx, h, i, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err = c.Send(ctx, 100); err != nil || len(b.sent) != 1 || b.sent[0].Verification.Account != account {
		t.Fatal("snapshot changed exact outgoing witness", err)
	}
	if snapshot, err := retained.AccountSnapshot(ctx); !errors.Is(err, Unavailable) || snapshot != (port.AccountObservation{}) {
		t.Fatal("snapshot capability survived dispatch", err)
	}
}

func TestSendAuthorizationSurvivesConversationFollow(t *testing.T) {
	for _, allowFollow := range []bool{true, false} {
		t.Run(map[bool]string{true: "current", false: "revoked"}[allowFollow], func(t *testing.T) {
			s, b, _, _ := conversationOwner(t)
			ctx := context.Background()
			h := admit(t, s, "1")
			calls := 0
			a := sendAuthorizationFunc(func(ctx context.Context, current port.SendCurrent) error {
				calls++
				if calls == 2 && !allowFollow {
					return Unavailable
				}
				return current.WithCurrent(ctx, func(binding port.TurnBinding) error {
					expected := input("1").Binding
					if calls == 2 {
						expected = followInput().Binding
					}
					if binding != expected {
						t.Fatal("authorization reused old turn")
					}
					return nil
				})
			})
			first, err := s.PromoteConversationAuthorized(ctx, h, input("1"), a)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			b.events = observations("user-1", "reply-1", "pear")
			if err = first.Send(ctx, 100); err != nil {
				t.Fatal(err)
			}
			observeOK(t, first)
			observeOK(t, first)
			observeOK(t, first)
			result, err := first.Result(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = first.Acknowledge(ctx, result.ResultID); err != nil {
				t.Fatal(err)
			}
			observeOK(t, first)
			next, err := s.FollowConversation(ctx, first, followInput())
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			if err = next.Send(ctx, 100); err != nil {
				t.Fatal(err)
			}
			expectedSends := 1
			if allowFollow {
				expectedSends = 2
			}
			if calls != 2 || len(b.sent) != expectedSends {
				t.Fatal("followup dropped authorization", calls, len(b.sent))
			}
		})
	}
}

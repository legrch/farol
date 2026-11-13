package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

type sendAuthorizationFunc = port.SendAuthorization

func authorizedConversation(t *testing.T, s *Service, ctx context.Context, i port.ConversationInput, a port.SendAuthorization, direct bool) (*Conversation, error) {
	t.Helper()
	if direct {
		return s.CreateConversationAuthorized(ctx, i, a)
	}
	return s.PromoteConversationAuthorized(ctx, admit(t, s, "1"), i, a)
}

func TestSendAuthorizationIsScopedToFinalKnownDispatch(t *testing.T) {
	testSendAuthorizationIsScopedToFinalKnownDispatch(t, false)
}

func TestCreateAuthorizationIsScopedToFinalKnownDispatch(t *testing.T) {
	testSendAuthorizationIsScopedToFinalKnownDispatch(t, true)
}

func testSendAuthorizationIsScopedToFinalKnownDispatch(t *testing.T, direct bool) {
	s, b, _, _ := conversationOwner(t)
	i := input("1")
	ctx := context.Background()
	var retained port.SendCurrent
	var h *Handle
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
	c, err := authorizedConversation(t, s, ctx, i, authorize, direct)
	if err != nil {
		t.Fatal(err)
	}
	h = c.handle
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
	testSendAuthorizationCannotSkipOrLoseItsCurrentCallback(t, false)
}

func TestCreateAuthorizationCannotSkipOrLoseItsCurrentCallback(t *testing.T) {
	testSendAuthorizationCannotSkipOrLoseItsCurrentCallback(t, true)
}

func testSendAuthorizationCannotSkipOrLoseItsCurrentCallback(t *testing.T, direct bool) {
	for _, kind := range []string{"skip", "account-snapshot-only", "refuse", "late-refusal", "late-nil-callback", "late-nil-context", "late-nil-snapshot-context"} {
		t.Run(kind, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			i := input("1")
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
				switch kind {
				case "late-nil-callback":
					_ = c.WithCurrent(ctx, nil)
				case "late-nil-context":
					_ = c.WithCurrent(nil, func(port.TurnBinding) error { return nil })
				case "late-nil-snapshot-context":
					_, _ = c.AccountSnapshot(nil)
				default:
					_ = c.WithCurrent(ctx, func(port.TurnBinding) error { return Unavailable })
				}
				return nil
			})
			c, err := authorizedConversation(t, s, ctx, i, a, direct)
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
	testSendAuthorizationAccountSnapshotIsExactDetachedAndExpires(t, false)
}

func TestCreateAuthorizationAccountSnapshotIsExactDetachedAndExpires(t *testing.T) {
	testSendAuthorizationAccountSnapshotIsExactDetachedAndExpires(t, true)
}

func testSendAuthorizationAccountSnapshotIsExactDetachedAndExpires(t *testing.T, direct bool) {
	s, b, _, _ := conversationOwner(t)
	i := input("1")
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
	c, err := authorizedConversation(t, s, ctx, i, a, direct)
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
	testSendAuthorizationSurvivesConversationFollow(t, false)
}

func TestCreateAuthorizationSurvivesConversationFollow(t *testing.T) {
	testSendAuthorizationSurvivesConversationFollow(t, true)
}

func testSendAuthorizationSurvivesConversationFollow(t *testing.T, direct bool) {
	for _, allowFollow := range []bool{true, false} {
		t.Run(map[bool]string{true: "current", false: "revoked"}[allowFollow], func(t *testing.T) {
			s, b, _, _ := conversationOwner(t)
			ctx := context.Background()
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
			first, err := authorizedConversation(t, s, ctx, input("1"), a, direct)
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

func TestCreateAuthorizationNilRefusedBeforeAdmission(t *testing.T) {
	s, b, j, _ := conversationOwner(t)
	writes := j.count()
	c, err := s.CreateConversationAuthorized(context.Background(), input("1"), nil)
	if c != nil || err != Invalid || j.count() != writes || len(s.handles) != 0 || len(b.prepares) != 0 || len(b.verifies) != 0 || len(b.sent) != 0 {
		t.Fatal("nil guard admitted or made effects", c, err)
	}
}

func TestAuthorizationTypedNilRefusedBeforeAdmission(t *testing.T) {
	for _, direct := range []bool{false, true} {
		for name, a := range map[string]port.SendAuthorization{"function": sendAuthorizationFunc(nil)} {
			t.Run(fmt.Sprintf("direct=%t/%s", direct, name), func(t *testing.T) {
				s, b, j, _ := conversationOwner(t)
				ctx, i := context.Background(), input("1")
				var h *Handle
				if !direct {
					h = admit(t, s, "1")
				}
				writes, handles := j.count(), len(s.handles)
				var c *Conversation
				var err error
				if direct {
					c, err = s.CreateConversationAuthorized(ctx, i, a)
				} else {
					c, err = s.PromoteConversationAuthorized(ctx, h, i, a)
				}
				if c != nil || err != Invalid || j.count() != writes || len(s.handles) != handles || len(b.prepares) != 0 || len(b.sent) != 0 {
					t.Fatal("typed nil guard admitted or made effects", c, err)
				}
			})
		}
	}
}

func TestCreateAuthorizationReplayKeepsOriginalGuardBeforeAdmission(t *testing.T) {
	s, b, j, _ := conversationOwner(t)
	ctx, i := context.Background(), input("1")
	calls, replacements := 0, 0
	original := sendAuthorizationFunc(func(ctx context.Context, current port.SendCurrent) error {
		calls++
		return current.WithCurrent(ctx, func(binding port.TurnBinding) error {
			if binding != i.Binding {
				t.Fatal("crossed binding")
			}
			return nil
		})
	})
	j.hook = func(w port.JournalWrite) {
		if w.Entry.Kind == "admit" {
			h := s.pending.handle
			if h.sendAuthorization == nil || h.conversation == nil || h.conversation.sendAuthorization == nil {
				t.Fatal("guard absent before admission commit")
			}
		}
	}
	c, err := s.CreateConversationAuthorized(ctx, i, original)
	if err != nil {
		t.Fatal(err)
	}
	writes := j.count()
	replacement := sendAuthorizationFunc(func(context.Context, port.SendCurrent) error {
		replacements++
		return Unavailable
	})
	replay, err := s.CreateConversationAuthorized(ctx, i, replacement)
	if err != nil || replay != c || j.count() != writes || calls != 0 || replacements != 0 {
		t.Fatal("replay changed admission or invoked authority", err)
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := replay.Send(ctx, 100); err != nil || calls != 1 || replacements != 0 || len(b.sent) != 1 {
		t.Fatal("replay replaced guard", err)
	}
	writes = j.count()
	if replay, err := s.CreateConversationAuthorized(ctx, i, replacement); err != nil || replay != c || j.count() != writes || calls != 1 || replacements != 0 || len(b.sent) != 1 {
		t.Fatal("post-send replay replaced guard or dispatched", err)
	}
}

func TestCreateAuthorizationGuardedUnguardedReplayConflicts(t *testing.T) {
	for _, guarded := range []bool{false, true} {
		t.Run(map[bool]string{false: "unguarded-first", true: "guarded-first"}[guarded], func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			ctx, i := context.Background(), input("1")
			a := sendAuthorizationFunc(func(context.Context, port.SendCurrent) error { return Unavailable })
			create := func(guard bool, in port.ConversationInput) (*Conversation, error) {
				if guard {
					return s.CreateConversationAuthorized(ctx, in, a)
				}
				return s.CreateConversation(ctx, in)
			}
			c, err := create(guarded, i)
			if err != nil {
				t.Fatal(err)
			}
			writes := j.count()
			if conflict, err := create(!guarded, i); conflict != nil || err != turn.Conflict || j.count() != writes {
				t.Fatal("guard mode conflict admitted", err)
			}
			changed := i
			changed.Prompt += " changed"
			if conflict, err := create(guarded, changed); conflict != nil || err != turn.Conflict || j.count() != writes {
				t.Fatal("changed intent admitted", err)
			}
			if replay, err := create(guarded, i); err != nil || replay != c || j.count() != writes || (c.handle.sendAuthorization != nil) != guarded {
				t.Fatal("conflict changed original admission", err)
			}
			if len(b.prepares) != 0 || len(b.verifies) != 0 || len(b.sent) != 0 {
				t.Fatal("replay conflict made effects")
			}
		})
	}
}

func TestCreateAuthorizationLowLevelSendCannotBypass(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	ctx, i := context.Background(), input("1")
	calls := 0
	c, err := s.CreateConversationAuthorized(ctx, i, sendAuthorizationFunc(func(context.Context, port.SendCurrent) error {
		calls++
		return Unavailable
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	view, err := s.Send(ctx, c.handle, i.Prompt, 100, i.Binding.OperationID)
	if err != nil || view == nil || !view.HasResult || view.Result.Outcome != turn.Failed || view.Result.Code != "SEND_NOT_SENT" || calls != 1 || len(b.sent) != 0 {
		t.Fatal("low-level Send bypassed guard or lost classification", view, err)
	}
}

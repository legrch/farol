package lifecycle

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Pure service regression: a committed intent is not evidence of physical Send.
// All browser/journal/result ports are in-memory fixtures.
func TestFreezeBeforePhysicalSendRetainsKnownNotSent(t *testing.T) {
	for _, boundary := range []string{"unguarded-verification", "guarded-verification", "before-final-guard", "after-final-guard"} {
		t.Run(boundary, func(t *testing.T) {
			s, browser, _, _ := conversationOwner(t)
			ctx := context.Background()
			freeze := func() {
				t.Helper()
				if err := s.FreezeAdmissions(ctx); err != nil {
					t.Fatal(err)
				}
			}
			var c *Conversation
			var err error
			if boundary == "unguarded-verification" {
				c, err = s.CreateConversation(ctx, input("1"))
			} else {
				c, err = s.PromoteConversationAuthorized(ctx, admit(t, s, "1"), input("1"), sendAuthorizationFunc(func(ctx context.Context, current port.SendCurrent) error {
					if boundary == "before-final-guard" {
						freeze()
					}
					called := false
					err := current.WithCurrent(ctx, func(port.TurnBinding) error { called = true; return nil })
					if boundary == "before-final-guard" {
						if err != Frozen || called {
							t.Fatal("frozen dispatch capability admitted callback", err)
						}
						if _, err := current.AccountSnapshot(ctx); err != Frozen {
							t.Fatal("frozen dispatch capability exposed account snapshot", err)
						}
					}
					if boundary == "after-final-guard" {
						freeze()
					}
					return err
				}))
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.PrepareNext(ctx, 100); err != nil {
				t.Fatal(err)
			}
			if boundary == "unguarded-verification" || boundary == "guarded-verification" {
				browser.verifyHook = func(*port.SendVerification) { freeze() }
			}
			if err := c.Send(ctx, 100); err != nil {
				t.Fatal("known pre-Send freeze failed to settle", err)
			}
			if len(browser.sent) != 0 {
				t.Fatal("physical Send started after admissions froze")
			}
			result, err := c.Result(ctx)
			if err != nil || result == nil || result.Code != "SEND_NOT_SENT" || result.Outcome != "failed" {
				t.Fatal("known no-Send result lost", result, err)
			}
			if err := c.Send(ctx, 100); err != Frozen || len(browser.sent) != 0 {
				t.Fatal("frozen Send was retried", err)
			}
		})
	}
}

package boot

import (
	"context"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/gate"
)

type accountSendClock struct{ now uint64 }

func (c *accountSendClock) NowMillis() uint64 { return c.now }

// Trusted setup simulates an explicit owner approval. Normal main/UI does not
// yet capture it; all storage, browser and provider effects are injected here.
func attachAccountForTest(t *testing.T, computer *ComputerIngress, a wire.ChatComputerAdmissionResponse, wrongScope bool) (*accountapproval.Service, *accountSendClock) {
	t.Helper()
	ctx := context.Background()
	captured, err := computer.capturedRead(a)
	if err != nil {
		t.Fatal(err)
	}
	b := captured.binding
	scope := chatport.AccountScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID}
	if wrongScope {
		scope.SessionID = "other-session"
	}
	clock := &accountSendClock{now: 1}
	owner, err := accountapproval.New(scope, &gate.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := owner.Approve(ctx, "explicit-account-approval", 0, chatport.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("c", 64), ObservedAtMillis: 1, ExpiresAtMillis: 100})
	if err != nil {
		t.Fatal(err)
	}
	captured.account = &capturedChatAccount{grant: grant, approvalID: "explicit-account-approval"}
	return owner, clock
}
func accountSendSnapshot() browser.AccountObservation {
	return browser.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("c", 64), ObservedAtMillis: 1, ExpiresAtMillis: 100}
}
func TestReadIntentAccountApprovalGuardsFinalDisclosure(t *testing.T) {
	for _, variant := range []string{"matching", "missing", "changed", "revoked", "replaced", "expired", "scope", "selected-id", "missing-grant"} {
		t.Run(variant, func(t *testing.T) {
			f, computer, a := readIntentFixture(t)
			ctx := context.Background()
			owner, clock := attachAccountForTest(t, computer, a, variant == "scope")
			f.physical.account = accountSendSnapshot()
			c, err := computer.capturedRead(a)
			if err != nil {
				t.Fatal(err)
			}
			if variant == "selected-id" {
				c.account.approvalID = "unapproved"
			}
			if variant == "missing-grant" {
				c.account.grant = nil
			}
			h, err := computer.promoteRead(ctx, "promote", readIntentPromotion(a))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.ingress.facade.PrepareNext(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			actual, err := f.ingress.get(h.HandleId)
			if err != nil {
				t.Fatal(err)
			}
			verified := false
			f.physical.verifyHook = func() {
				verified = true
				switch variant {
				case "missing":
					f.physical.account = browser.AccountObservation{}
				case "changed":
					f.physical.account.PrincipalKey = strings.Repeat("d", 64)
				case "revoked":
					if _, err := owner.Revoke(ctx, 1); err != nil {
						t.Fatal(err)
					}
				case "replaced":
					if _, err := owner.Approve(ctx, "replacement-approval", 1, chatport.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("c", 64), ObservedAtMillis: 1, ExpiresAtMillis: 100}); err != nil {
						t.Fatal(err)
					}
				case "expired":
					clock.now = 100
				}
			}
			// Bypass the ingress convenience wrapper: the actual Chat handle retains
			// this final authorization, so direct callers cannot omit account checking.
			if err := actual.handle.Send(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			if !verified {
				t.Fatal("verification did not run")
			}
			if variant == "matching" {
				if f.physical.sends != 1 {
					t.Fatal("approved dispatch missing")
				}
				return
			}
			if f.physical.sends != 0 {
				t.Fatal("unapproved account disclosed prompt")
			}
			result, err := actual.handle.Result(ctx)
			if err != nil || result.Code != "SEND_NOT_SENT" || result.Outcome != "failed" {
				t.Fatal("known refusal lost", result, err)
			}
			entries := len(f.journal.entries)
			if err := actual.handle.Send(ctx, 10000); err == nil || f.physical.sends != 0 || len(f.journal.entries) != entries {
				t.Fatal("refused account dispatch replayed", err)
			}
		})
	}
}
func TestReadIntentAccountApprovalIsRetainedOnExactFollowup(t *testing.T) {
	for _, variant := range []string{"matching", "account-revoked", "computer-revoked"} {
		t.Run(variant, func(t *testing.T) {
			f, computer, a := readIntentFixture(t)
			ctx := context.Background()
			owner, _ := attachAccountForTest(t, computer, a, false)
			f.physical.account = accountSendSnapshot()
			h, err := computer.promoteRead(ctx, "promote", readIntentPromotion(a))
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.ingress.facade.PrepareNext(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			actual, err := f.ingress.get(h.HandleId)
			if err != nil {
				t.Fatal(err)
			}
			if err = actual.handle.Send(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			for n := 0; n < 2; n++ {
				if err = actual.handle.Observe(ctx, 10000); err != nil {
					t.Fatal(err)
				}
			}
			result := f.finish(t, actual)
			next := chatComputerInput(false)
			selected := readIntentPromotion(a)
			next.Selection, next.Resolution = selected.Selection, selected.Resolution
			next.PreviousHandle = &h.HandleId
			follow, err := f.ingress.create(ctx, "followup", next)
			if err != nil {
				t.Fatal(err)
			}
			if follow.Binding.TaskId != a.TaskId || follow.Binding.TurnId == a.TurnId {
				t.Fatal("followup identity lost")
			}
			prepared, err := f.ingress.facade.PrepareNext(ctx, 10000)
			if err != nil || prepared.ConversationID != result.ConversationID {
				t.Fatal("provider identity lost", err)
			}
			second, err := f.ingress.get(follow.HandleId)
			if err != nil {
				t.Fatal(err)
			}
			f.physical.verifyHook = func() {
				if variant == "account-revoked" {
					if _, err := owner.Revoke(ctx, 1); err != nil {
						t.Fatal(err)
					}
				}
				if variant == "computer-revoked" {
					if _, err := computer.Deactivate(ctx, "followup-revoked"); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err = second.handle.Send(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			if variant == "matching" {
				if f.physical.sends != 2 {
					t.Fatal("approved followup lost exact authority")
				}
				return
			}
			if f.physical.sends != 1 {
				t.Fatal("followup dropped captured account authority")
			}
			refused, err := second.handle.Result(ctx)
			if err != nil || refused.Code != "SEND_NOT_SENT" {
				t.Fatal("followup refusal missing", refused, err)
			}
		})
	}
}

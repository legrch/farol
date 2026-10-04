package boot

import (
	"context"
	"reflect"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

func readAccountInput(a wire.ChatComputerAdmissionResponse) wire.ChatReadIntentAccountApprove {
	return wire.ChatReadIntentAccountApprove{Admission: a, ConfirmedPrincipalKey: strings.Repeat("c", 64), Observation: wire.BrowserAccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("c", 64), ObservedAtMillis: "1", ExpiresAtMillis: "100"}}
}
func approveReadAccountFixture(t *testing.T, computer *ComputerIngress, a wire.ChatComputerAdmissionResponse) *wire.ChatReadIntentAccountApproved {
	t.Helper()
	computer.accountClock = &accountSendClock{now: 1}
	receipt, err := computer.approveReadAccount(context.Background(), "explicit-account", readAccountInput(a))
	if err != nil || receipt == nil {
		t.Fatal("explicit account approval", receipt, err)
	}
	return receipt
}

func TestReadIntentAccountExplicitApprovalIsRequiredAndRetained(t *testing.T) {
	f, computer, a := readIntentUnapprovedFixture(t)
	ctx := context.Background()
	before, claims := len(f.journal.entries), len(computer.used)
	if h, err := computer.promoteRead(ctx, "without-confirmation", readIntentPromotion(a)); err == nil || h != nil || len(f.journal.entries) != before || len(computer.used) != claims {
		t.Fatal("observation-free intent promoted without approval", h, err)
	}
	r := approveReadAccountFixture(t, computer, a)
	if r.Admission != a || r.ApprovalId == "" || r.PrincipalKey != readAccountInput(a).ConfirmedPrincipalKey || len(f.journal.entries) != before || f.physical.sends != 0 {
		t.Fatal("approval changed owner, journal or browser", r)
	}
	claims = len(computer.used)
	want := *r
	r.ApprovalId = "caller-mutated"
	for _, operation := range []string{"explicit-account", "duplicate-confirmation"} {
		got, err := computer.approveReadAccount(ctx, operation, readAccountInput(a))
		if err != nil || got == nil || *got != want || len(computer.used) != claims {
			t.Fatal("exact replay did not retain original private grant", got, err)
		}
	}
	changed := readAccountInput(a)
	changed.Observation.ObservedAtMillis = "2"
	if _, err := computer.approveReadAccount(ctx, "refresh-by-replay", changed); err == nil || len(computer.used) != claims {
		t.Fatal("approval silently refreshed", err)
	}
	if _, err := computer.promoteRead(ctx, "promote-confirmed", readIntentPromotion(a)); err != nil {
		t.Fatal(err)
	}
}

func TestReadIntentAccountRefusesInvalidOrStaleConfirmationBeforeGrant(t *testing.T) {
	for _, variant := range []string{"principal-mismatch", "owner", "session", "task", "turn", "participant", "operation", "store-revision", "stale", "future", "expired", "unsafe-time", "withdrawn", "authority-withdrawn", "cancelled"} {
		t.Run(variant, func(t *testing.T) {
			f, computer, a := readIntentUnapprovedFixture(t)
			clock := &accountSendClock{now: 1}
			computer.accountClock = clock
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			in := readAccountInput(a)
			switch variant {
			case "principal-mismatch":
				in.ConfirmedPrincipalKey = strings.Repeat("d", 64)
			case "owner":
				in.Admission.OwnerId = "other"
			case "session":
				in.Admission.SessionId = "other"
			case "task":
				in.Admission.TaskId = "other"
			case "turn":
				in.Admission.TurnId = "other"
			case "participant":
				in.Admission.ParticipantId = "other"
			case "operation":
				in.Admission.AdmissionOperationId = "other"
			case "store-revision":
				in.Admission.StoreRevision = "999"
			case "stale":
				clock.now = 5002
				in.Observation.ExpiresAtMillis = "10000"
			case "future":
				in.Observation.ObservedAtMillis = "2"
			case "expired":
				clock.now = 100
			case "unsafe-time":
				in.Observation.ExpiresAtMillis = "9007199254740992"
			case "withdrawn":
				if _, err := computer.withdrawRead(ctx, "discard", wire.ChatReadIntentWithdraw{Admission: a}); err != nil {
					t.Fatal(err)
				}
			case "authority-withdrawn":
				if _, err := computer.Deactivate(ctx, "withdraw-authority"); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			before := len(f.journal.entries)
			if r, err := computer.approveReadAccount(ctx, "owner-confirmation", in); err == nil || r != nil {
				t.Fatal("invalid confirmation accepted", r, err)
			}
			c, err := computer.capturedRead(a)
			if err != nil || c.account != nil || c.accountOwner != nil || len(f.journal.entries) != before || f.physical.sends != 0 {
				t.Fatal("refusal retained authority or performed effect", err)
			}
		})
	}
}

func TestReadIntentAccountRevokeBlocksQueuedSendAndCannotBeReapproved(t *testing.T) {
	f, computer, a := readIntentFixture(t)
	ctx := context.Background()
	c, _ := computer.capturedRead(a)
	receipt := *c.accountReceipt
	h, err := computer.promoteRead(ctx, "queued-send", readIntentPromotion(a))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.ingress.facade.PrepareNext(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	request := wire.ChatReadIntentAccountRevoke{Admission: a, ApprovalId: receipt.ApprovalId}
	wrong := request
	wrong.ApprovalId = "copied-unowned"
	if _, err = computer.revokeReadAccount(ctx, "wrong-revoke", wrong); err == nil {
		t.Fatal("wrong approval selected")
	}
	before := len(f.journal.entries)
	result, err := computer.revokeReadAccount(ctx, "explicit-revoke", request)
	if err != nil || result == nil || result.Admission != a || len(f.journal.entries) != before {
		t.Fatal("revoke", result, err)
	}
	claims := len(computer.used)
	again, err := computer.revokeReadAccount(ctx, "duplicate-revoke", request)
	if err != nil || !reflect.DeepEqual(result, again) || len(computer.used) != claims {
		t.Fatal("revoke replay", again, err)
	}
	if _, err = computer.approveReadAccount(ctx, "replace-revoked", readAccountInput(a)); err == nil {
		t.Fatal("revoked intent approved again")
	}
	actual, _ := f.ingress.get(h.HandleId)
	if err = actual.handle.Send(ctx, 10000); err != nil || f.physical.sends != 0 {
		t.Fatal("revoked grant sent", err)
	}
	terminal, err := actual.handle.Result(ctx)
	if err != nil || terminal.Code != "SEND_NOT_SENT" {
		t.Fatal("refusal lost", terminal, err)
	}
}

func readAccountWireFixture(t *testing.T) (*chatComputerFixture, *ComputerIngress, wire.ChatComputerAdmissionResponse, *taskWireTestPeer) {
	t.Helper()
	f := newChatComputerFixture(t)
	computer, _, _, _ := f.computer(t)
	computer.publication.receipt.SettingsRevision = "1"
	computer.publication.receipt.PublishOperationId = "publication"
	computer.publication.receipt.ApprovalDigest = strings.Repeat("a", 64)
	computer.accountClock = &accountSendClock{now: 1}
	peer := chatComputerWireConnect(t, f, computer)
	a := taskWireTestData[wire.ChatComputerAdmissionResponse](t, peer.call("chat.turn", "wire-read", chatComputerWireJSON(t, wire.ChatComputerAdmissionRequest{Publication: computer.publication.receipt, SessionId: "session", TaskId: "wire-task", TurnId: "wire-turn", WorkspaceIds: []string{"work"}})), "ChatComputerAdmissionResponse")
	return f, computer, a, peer
}

func TestReadIntentAccountWireApprovalAndRevoke(t *testing.T) {
	f, _, a, peer := readAccountWireFixture(t)
	r := taskWireTestData[wire.ChatReadIntentAccountApproved](t, peer.call("chat.readintent.account.approve", "wire-account", chatComputerWireJSON(t, readAccountInput(a))), "ChatReadIntentAccountApproved")
	if r.Admission != a || r.PrincipalKey != readAccountInput(a).ConfirmedPrincipalKey {
		t.Fatal("wire approval crossed", r)
	}
	v := taskWireTestData[wire.ChatReadIntentWithdrawn](t, peer.call("chat.readintent.account.revoke", "wire-revoke", chatComputerWireJSON(t, wire.ChatReadIntentAccountRevoke{Admission: a, ApprovalId: r.ApprovalId})), "ChatReadIntentWithdrawn")
	if v.Admission != a || f.physical.sends != 0 {
		t.Fatal("wire revoke", v)
	}
}

type readAccountHookClock struct{ hook func() }

func (c readAccountHookClock) NowMillis() uint64 { c.hook(); return 1 }

func TestReadIntentAccountWireClassifiesKnownRefusalWithoutGrant(t *testing.T) {
	for _, variant := range []string{"stale", "expired", "principal", "revoke-id"} {
		t.Run(variant, func(t *testing.T) {
			f, computer, a, peer := readAccountWireFixture(t)
			input := readAccountInput(a)
			method, shape, code := "chat.readintent.account.approve", "ChatReadIntentAccountApprove", "CHAT_ACCOUNT_APPROVAL_STALE"
			var body any = input
			switch variant {
			case "stale":
				computer.accountClock = &accountSendClock{now: 5002}
				input.Observation.ExpiresAtMillis = "10000"
				body = input
			case "expired":
				computer.accountClock = &accountSendClock{now: 100}
			case "principal":
				input.ConfirmedPrincipalKey = strings.Repeat("d", 64)
				body = input
				code = "read_intent_account_invalid"
			case "revoke-id":
				_ = approveReadAccountFixture(t, computer, a)
				method, shape, code = "chat.readintent.account.revoke", "ChatReadIntentAccountRevoke", "read_intent_account_not_owned"
				body = wire.ChatReadIntentAccountRevoke{Admission: a, ApprovalId: "other-approval"}
			}
			if validateIngress(shape, body) != nil {
				t.Fatal("fixture must pass wire validation")
			}
			before := len(f.journal.entries)
			result := peer.call(method, "known-refusal", chatComputerWireJSON(t, body))
			if result.Result == nil || result.Result.Status != "refused" || (result.Result.Code == nil || *result.Result.Code != code) || (result.Result.OperationId == nil || *result.Result.OperationId != "known-refusal") || result.Result.Context != computer.peer {
				t.Fatal("known refusal lost", result)
			}
			c, err := computer.capturedRead(a)
			if err != nil || (variant != "revoke-id" && c.account != nil) || (variant == "revoke-id" && c.accountRevoked) || len(f.journal.entries) != before || f.physical.sends != 0 {
				t.Fatal("refusal changed grant/journal or sent", err)
			}
			if (variant == "stale" || variant == "expired") && !computer.used["known-refusal"] {
				t.Fatal("refused policy call must retain consumed operation claim")
			}
		})
	}
}

func TestReadIntentAccountWireKeepsLateGrantOutcomeUnknown(t *testing.T) {
	f, computer, a, peer := readAccountWireFixture(t)
	c, err := computer.capturedRead(a)
	if err != nil {
		t.Fatal(err)
	}
	computer.accountClock = readAccountHookClock{hook: func() { _, _ = computer.guard.deactivate() }}
	result := peer.call("chat.readintent.account.approve", "late-withdrawal", chatComputerWireJSON(t, readAccountInput(a)))
	if result.Result == nil || result.Result.Status != "unknown" || (result.Result.Code == nil || *result.Result.Code != "owner_outcome_unknown") || (result.Result.OperationId == nil || *result.Result.OperationId != "late-withdrawal") || result.Result.Context != computer.peer {
		t.Fatal("late grant outcome upgraded", result)
	}
	if c.account == nil || c.accountReceipt != nil || !computer.unknown || f.physical.sends != 0 {
		t.Fatal("late grant was not fenced")
	}
	if _, err = computer.approveReadAccount(context.Background(), "replacement", readAccountInput(a)); err == nil {
		t.Fatal("poisoned account admission retried")
	}
}

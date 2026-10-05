package boot

// Source-only tests: real Chat facade/lifecycle, in-memory results, scripted
// journal and injected browser Exchange. No Computer/native/provider work runs.
// Read-intent admission/promotion is ONLY a private SendCurrent capability
// factory here; it is neither the eventual typed Create endpoint nor a Computer
// read. Trusted setup mints the existing accountapproval service's private grant.
import (
	"context"
	"errors"
	"strings"
	"testing"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/gate"
)

type chatAccountAuthorizationFunc = conversation.SendAuthorization

func chatAccountAuthorizationInput() conversation.Input {
	w := chatComputerInput(false)
	w.Selection.AccountId = strings.Repeat("c", 64)
	w.Resolution.Resolved = w.Selection
	return conversation.Input{
		Binding:   conversation.Binding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 1},
		Required:  conversation.RequiredControls{Model: w.Required.Model, Effort: w.Required.Effort, Mode: w.Required.Mode},
		Selection: chatSelection(w.Selection), Resolution: chatResolution(w.Resolution), Prompt: w.Prompt,
	}
}

func chatAccountAuthorizationScope(b conversation.Binding) chatport.AccountScope {
	return chatport.AccountScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID}
}

func chatAccountAuthorizationObservation() chatport.AccountObservation {
	s := accountSendSnapshot()
	return chatport.AccountObservation{State: s.State, Source: s.Source, PrincipalKey: s.PrincipalKey, ObservedAtMillis: s.ObservedAtMillis, ExpiresAtMillis: s.ExpiresAtMillis}
}

func chatAccountAuthorizationApproval(t *testing.T, scope chatport.AccountScope) (*capturedChatAccount, *accountapproval.Service, *accountSendClock) {
	t.Helper()
	clock := &accountSendClock{now: 1}
	owner, err := accountapproval.New(scope, &gate.Mutex{}, clock)
	if err != nil {
		t.Fatal("account approval service", err)
	}
	// This is the explicit owner approval in trusted test setup. A declared
	// account ID and browser observation alone do not mint a private Grant.
	const approvalID = "explicit-account-approval"
	grant, err := owner.Approve(context.Background(), approvalID, 0, chatAccountAuthorizationObservation())
	if err != nil {
		t.Fatal("explicit approval", err)
	}
	return &capturedChatAccount{grant: grant, approvalID: approvalID}, owner, clock
}

func chatAccountAuthorizationCapture(t *testing.T, account *capturedChatAccount, input conversation.Input) *chatAccountAuthorization {
	t.Helper()
	a, err := newChatAccountAuthorization(account, input.Binding, input.Selection.AccountID)
	if err != nil || a == nil {
		t.Fatal("capture authorization", a, err)
	}
	return a
}

func chatAccountAuthorizationPromote(t *testing.T, f *chatComputerFixture, input conversation.Input, a conversation.SendAuthorization) *conversation.Handle {
	t.Helper()
	ctx := context.Background()
	// Capability factory only: this never constructs or executes a Computer read
	// and does not exercise the future authorized typed Create integration.
	r, err := f.ingress.facade.AdmitReadIntent(ctx, input.Binding, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal("private Chat admission", err)
	}
	h, err := f.ingress.facade.PromoteReadIntentAuthorized(ctx, r, input, a)
	if err != nil || h == nil {
		t.Fatal("capture final Send authorization", h, err)
	}
	if f.physical.prepares != 0 || f.physical.sends != 0 || f.physical.observes != 0 {
		t.Fatal("capability factory performed a browser effect")
	}
	return h
}

func chatAccountAuthorizationPrepare(t *testing.T, f *chatComputerFixture, binding conversation.Binding) *conversation.Prepared {
	t.Helper()
	p, err := f.ingress.facade.PrepareNext(context.Background(), 10000)
	if err != nil || p == nil || p.Binding != binding {
		t.Fatal("prepare exact Chat turn", p, err)
	}
	return p
}

func chatAccountAuthorizationFinish(t *testing.T, h *conversation.Handle) *conversation.Result {
	t.Helper()
	ctx := context.Background()
	for range 4 {
		if err := h.Observe(ctx, 10000); err != nil {
			t.Fatal("injected acceptance/completion observation", err)
		}
	}
	r, err := h.Result(ctx)
	if err != nil || r == nil || !r.Complete || r.Acknowledged || r.Outcome != "completed" || r.ConversationID == "" {
		t.Fatal("completed result before ACK", r, err)
	}
	if err := h.Acknowledge(ctx, r.ResultID); err != nil {
		t.Fatal("business result ACK", err)
	}
	if err := h.Observe(ctx, 10000); err != nil {
		t.Fatal("injected quiescence/settlement", err)
	}
	if err := h.WithState(ctx, func(s conversation.State) error {
		if !s.DeliveryAcknowledged || !s.LifecycleSettled || !s.Released || !s.FollowReady {
			t.Fatal("Follow before actual ACK/settlement/release", s)
		}
		return nil
	}); err != nil {
		t.Fatal("settled first turn", err)
	}
	return r
}

func chatAccountAuthorizationRefused(t *testing.T, f *chatComputerFixture, h *conversation.Handle, binding conversation.Binding, sends int) {
	t.Helper()
	ctx := context.Background()
	r, err := h.Result(ctx)
	if err != nil || r == nil || r.Binding != binding || r.Outcome != "failed" || r.Code != "SEND_NOT_SENT" || r.Complete || r.Acknowledged || f.physical.sends != sends {
		t.Fatal("known final refusal or physical Send count changed", r, f.physical.sends, err)
	}
	if sends == 0 && (r.ConversationID != "" || r.UserTurnID != "" || r.ReplyID != "" || r.Text != "") {
		t.Fatal("never-sent result invented provider output", r)
	}
	entries, prepares, observes := len(f.journal.entries), f.physical.prepares, f.physical.observes
	// This explicit prohibited replay probe must refuse locally, with no new
	// verification, journal write or Exchange Send. It is not a provider retry.
	err = h.Send(ctx, 10000)
	var failure *conversation.Failure
	if !errors.As(err, &failure) || failure.Retry != "never" || f.physical.sends != sends || f.physical.prepares != prepares || f.physical.observes != observes || len(f.journal.entries) != entries {
		t.Fatal("known refusal admitted a replay", err)
	}
}

func TestChatAccountAuthorizationConstructorRejectsInvalidCapture(t *testing.T) {
	input := chatAccountAuthorizationInput()
	account, _, _ := chatAccountAuthorizationApproval(t, chatAccountAuthorizationScope(input.Binding))
	for _, variant := range []string{
		"nil-account", "nil-grant", "empty-approval-id", "invalid-approval-id", "long-approval-id",
		"empty-selected-account", "invalid-selected-account", "long-selected-account",
		"profile", "backend", "owner", "session", "task", "participant", "turn", "operation", "task-epoch", "turn-generation", "invalid-binding-id",
	} {
		t.Run(variant, func(t *testing.T) {
			copied, b, selected := *account, input.Binding, input.Selection.AccountID
			candidate := &copied
			switch variant {
			case "nil-account":
				candidate = nil
			case "nil-grant":
				copied.grant = nil
			case "empty-approval-id":
				copied.approvalID = ""
			case "invalid-approval-id":
				copied.approvalID = "bad\nid"
			case "long-approval-id":
				copied.approvalID = strings.Repeat("a", 121)
			case "empty-selected-account":
				selected = ""
			case "invalid-selected-account":
				selected = "bad\nid"
			case "long-selected-account":
				selected = strings.Repeat("a", 121)
			case "profile":
				b.ProfileID = ""
			case "backend":
				b.BackendGeneration = ""
			case "owner":
				b.OwnerID = ""
			case "session":
				b.SessionID = ""
			case "task":
				b.TaskID = ""
			case "participant":
				b.ParticipantID = ""
			case "turn":
				b.TurnID = ""
			case "operation":
				b.OperationID = ""
			case "task-epoch":
				b.TaskEpoch = 0
			case "turn-generation":
				b.TurnGeneration = 0
			case "invalid-binding-id":
				b.TaskID = "bad\nid"
			}
			if a, err := newChatAccountAuthorization(candidate, b, selected); a != nil || err == nil || err.Error() != "chat_account_authorization_invalid" {
				t.Fatal("invalid capture acquired authorization", a, err)
			}
		})
	}
}

func TestChatAccountAuthorizationRejectsNilAndUnissuedCurrent(t *testing.T) {
	input := chatAccountAuthorizationInput()
	account, _, _ := chatAccountAuthorizationApproval(t, chatAccountAuthorizationScope(input.Binding))
	a := chatAccountAuthorizationCapture(t, account, input)
	for _, test := range []struct {
		name    string
		a       *chatAccountAuthorization
		ctx     context.Context
		current *conversation.SendCurrent
		want    string
	}{
		{"nil-receiver", nil, context.Background(), &conversation.SendCurrent{}, "chat_account_authorization_invalid"},
		{"nil-context", a, nil, &conversation.SendCurrent{}, "chat_account_authorization_invalid"},
		{"nil-current", a, context.Background(), nil, "chat_account_authorization_invalid"},
		{"missing-grant", &chatAccountAuthorization{}, context.Background(), &conversation.SendCurrent{}, "chat_account_authorization_invalid"},
		{"unissued-current", a, context.Background(), &conversation.SendCurrent{}, "chat_account_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.a.Authorize(test.ctx, test.current); err == nil || err.Error() != test.want {
				t.Fatal("invalid send capability accepted", err)
			}
		})
	}
}

func TestChatAccountAuthorizationFinalDisclosureRequiresCurrentExplicitApproval(t *testing.T) {
	for _, variant := range []string{
		"matching", "unminted-grant", "copied-grant", "selected-approval-id", "selected-account",
		"scope-profile", "scope-backend", "scope-owner", "scope-session",
		"missing-observation", "unknown-observation", "changed-principal", "changed-source", "revoked", "replaced", "expired", "observation-expired",
	} {
		t.Run(variant, func(t *testing.T) {
			f := newChatComputerFixture(t)
			input := chatAccountAuthorizationInput()
			scope := chatAccountAuthorizationScope(input.Binding)
			switch variant {
			case "scope-profile":
				scope.ProfileID = "other-profile"
			case "scope-backend":
				scope.BackendGeneration = "other-backend"
			case "scope-owner":
				scope.OwnerID = "other-owner"
			case "scope-session":
				scope.SessionID = "other-session"
			}
			account, owner, clock := chatAccountAuthorizationApproval(t, scope)
			switch variant {
			case "unminted-grant":
				account.grant = &accountapproval.Grant{}
			case "copied-grant":
				copied := *account.grant
				account.grant = &copied
			case "selected-approval-id":
				account.approvalID = "unapproved"
			case "selected-account":
				input.Selection.AccountID = strings.Repeat("d", 64)
				input.Resolution.Resolved = input.Selection
			}
			a := chatAccountAuthorizationCapture(t, account, input)
			calls := 0
			h := chatAccountAuthorizationPromote(t, f, input, chatAccountAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
				calls++
				return a.Authorize(ctx, current)
			}))
			f.physical.account = accountSendSnapshot()
			chatAccountAuthorizationPrepare(t, f, input.Binding)
			verified := 0
			f.physical.verifyHook = func() {
				verified++
				switch variant {
				case "missing-observation":
					f.physical.account = browser.AccountObservation{}
				case "unknown-observation":
					f.physical.account.State = "unknown"
				case "changed-principal":
					f.physical.account.PrincipalKey = strings.Repeat("d", 64)
				case "changed-source":
					f.physical.account.Source = "unknown"
				case "revoked":
					if _, err := owner.Revoke(context.Background(), 1); err != nil {
						t.Fatal("revoke private approval", err)
					}
				case "replaced":
					if _, err := owner.Approve(context.Background(), "replacement-approval", 1, chatAccountAuthorizationObservation()); err != nil {
						t.Fatal("replace private approval with same principal", err)
					}
				case "expired":
					clock.now = 100
				case "observation-expired":
					f.physical.account.ObservedAtMillis = 2
					f.physical.account.ExpiresAtMillis = 50
					clock.now = 50
				}
			}
			if err := h.Send(context.Background(), 10000); err != nil {
				t.Fatal("known send settlement", err)
			}
			if verified != 1 || calls != 1 {
				t.Fatal("final private authorization boundary was bypassed", verified, calls)
			}
			if variant == "matching" {
				if f.physical.sends != 1 {
					t.Fatal("current explicit approval did not send once")
				}
				return
			}
			chatAccountAuthorizationRefused(t, f, h, input.Binding, 0)
			if verified != 1 || calls != 1 {
				t.Fatal("refused turn retried verification/authorization")
			}
		})
	}
}

func TestChatAccountAuthorizationRejectsCrossedStableLineage(t *testing.T) {
	for _, variant := range []string{"profile", "backend", "owner", "session", "task", "task-epoch", "participant", "same-generation-same-turn", "same-operation", "same-generation", "older-generation"} {
		t.Run(variant, func(t *testing.T) {
			f := newChatComputerFixture(t)
			input := chatAccountAuthorizationInput()
			input.Binding.TurnGeneration = 2
			original := input
			original.Binding.TurnID, original.Binding.OperationID, original.Binding.TurnGeneration = "original-turn", "original-operation", 1
			// Give the unrelated live capability a successor-shaped turn, but
			// cross exactly one captured lineage field. Approval scope matches
			// the capture, so account freshness alone cannot explain refusal.
			switch variant {
			case "profile":
				original.Binding.ProfileID = "other-profile"
			case "backend":
				original.Binding.BackendGeneration = "other-backend"
			case "owner":
				original.Binding.OwnerID = "other-owner"
			case "session":
				original.Binding.SessionID = "other-session"
			case "task":
				original.Binding.TaskID = "other-task"
			case "task-epoch":
				original.Binding.TaskEpoch++
			case "participant":
				original.Binding.ParticipantID = "other-participant"
			case "same-generation-same-turn":
				original.Binding.TurnID = input.Binding.TurnID
				original.Binding.TurnGeneration = input.Binding.TurnGeneration
			case "same-operation":
				original.Binding.OperationID = input.Binding.OperationID
			case "same-generation":
				original.Binding.TurnGeneration = input.Binding.TurnGeneration
			case "older-generation":
				original.Binding.TurnGeneration = input.Binding.TurnGeneration + 1
			}
			account, _, _ := chatAccountAuthorizationApproval(t, chatAccountAuthorizationScope(original.Binding))
			a := chatAccountAuthorizationCapture(t, account, original)
			calls := 0
			var refused error
			h := chatAccountAuthorizationPromote(t, f, input, chatAccountAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
				calls++
				refused = a.Authorize(ctx, current)
				return refused
			}))
			f.physical.account = accountSendSnapshot()
			chatAccountAuthorizationPrepare(t, f, input.Binding)
			if err := h.Send(context.Background(), 10000); err != nil {
				t.Fatal("known crossed-lineage settlement", err)
			}
			if calls != 1 || !errors.Is(refused, accountapproval.Unavailable) {
				t.Fatal("crossed live Chat callback did not refuse", calls, refused)
			}
			chatAccountAuthorizationRefused(t, f, h, input.Binding, 0)
			if calls != 1 {
				t.Fatal("crossed authorization retried")
			}
		})
	}
}

func TestChatAccountAuthorizationCapturesCallerValuesAndGuardsFacadeFollow(t *testing.T) {
	for _, variant := range []string{"matching", "changed-principal", "revoked", "replaced", "expired", "changed-selection"} {
		t.Run(variant, func(t *testing.T) {
			ctx := context.Background()
			f := newChatComputerFixture(t)
			input := chatAccountAuthorizationInput()
			account, owner, clock := chatAccountAuthorizationApproval(t, chatAccountAuthorizationScope(input.Binding))
			a := chatAccountAuthorizationCapture(t, account, input)
			admitted := input
			// Caller-owned originals can change after capture. The same guard
			// must retain binding, approval ID, grant pointer and requested account.
			input.Binding = conversation.Binding{}
			input.Selection.AccountID = strings.Repeat("d", 64)
			account.approvalID, account.grant = "unapproved", nil
			calls := 0
			captured := chatAccountAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
				calls++
				return a.Authorize(ctx, current)
			})
			h := chatAccountAuthorizationPromote(t, f, admitted, captured)
			f.physical.account = accountSendSnapshot()
			chatAccountAuthorizationPrepare(t, f, admitted.Binding)
			if err := h.Send(ctx, 10000); err != nil || f.physical.sends != 1 || calls != 1 {
				t.Fatal("caller mutation redirected captured first Send", err, calls, f.physical.sends)
			}
			first := chatAccountAuthorizationFinish(t, h)
			next := admitted
			next.Binding.TurnID, next.Binding.OperationID = "follow-turn", "follow-operation"
			next.Binding.TurnGeneration++
			next.Prompt = "Same conversation follow-up"
			if variant == "changed-selection" {
				next.Selection.AccountID = strings.Repeat("d", 64)
				next.Resolution.Resolved = next.Selection
				follow, err := f.ingress.facade.Follow(ctx, h, next)
				var failure *conversation.Failure
				if follow != nil || !errors.As(err, &failure) || failure.Code != "CHAT_LIFECYCLE_MISMATCH" || failure.Retry != "never" || calls != 1 || f.physical.sends != 1 {
					t.Fatal("Follow accepted a changed requested account", follow, err)
				}
				return
			}
			follow, err := f.ingress.facade.Follow(ctx, h, next)
			if err != nil || follow == nil {
				t.Fatal("actual Facade.Follow after ACK/settlement", follow, err)
			}
			p := chatAccountAuthorizationPrepare(t, f, next.Binding)
			if p.ConversationID != first.ConversationID || p.Binding.ProfileID != first.Binding.ProfileID || p.Binding.BackendGeneration != first.Binding.BackendGeneration || p.Binding.OwnerID != first.Binding.OwnerID || p.Binding.SessionID != first.Binding.SessionID || p.Binding.TaskID != first.Binding.TaskID || p.Binding.TaskEpoch != first.Binding.TaskEpoch || p.Binding.ParticipantID != first.Binding.ParticipantID || p.Binding.TurnID == first.Binding.TurnID || p.Binding.OperationID == first.Binding.OperationID || p.Binding.TurnGeneration != first.Binding.TurnGeneration+1 {
				t.Fatal("Follow crossed conversation/stable lineage", p, first)
			}
			f.physical.verifyHook = func() {
				switch variant {
				case "changed-principal":
					f.physical.account.PrincipalKey = strings.Repeat("d", 64)
				case "revoked":
					if _, err := owner.Revoke(ctx, 1); err != nil {
						t.Fatal(err)
					}
				case "replaced":
					if _, err := owner.Approve(ctx, "replacement-approval", 1, chatAccountAuthorizationObservation()); err != nil {
						t.Fatal(err)
					}
				case "expired":
					clock.now = 100
				}
			}
			if err := follow.Send(ctx, 10000); err != nil || calls != 2 {
				t.Fatal("Follow dropped original disclosure guard", err, calls)
			}
			if variant == "matching" {
				second := chatAccountAuthorizationFinish(t, follow)
				if f.physical.sends != 2 || second.Binding != next.Binding || second.ConversationID != first.ConversationID {
					t.Fatal("approved Follow did not keep exact conversation", second)
				}
				retained, err := h.Result(ctx)
				if err != nil || retained.Binding != first.Binding || retained.Text != first.Text || retained.ConversationID != second.ConversationID || !retained.Acknowledged || f.physical.sends != 2 {
					t.Fatal("Follow changed historical result or sent again", retained, err)
				}
				return
			}
			chatAccountAuthorizationRefused(t, f, follow, next.Binding, 1)
			if calls != 2 {
				t.Fatal("Follow refusal retried original guard")
			}
		})
	}
}

func TestChatAccountAuthorizationRetainedSendCurrentCannotAuthorizeLaterTurn(t *testing.T) {
	ctx := context.Background()
	f := newChatComputerFixture(t)
	input := chatAccountAuthorizationInput()
	account, _, _ := chatAccountAuthorizationApproval(t, chatAccountAuthorizationScope(input.Binding))
	a := chatAccountAuthorizationCapture(t, account, input)
	var retained *conversation.SendCurrent
	calls := 0
	h := chatAccountAuthorizationPromote(t, f, input, chatAccountAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
		calls++
		if calls == 1 {
			retained = current
			return a.Authorize(ctx, current)
		}
		// Deliberately try the retained first-turn capability instead of the
		// newly issued one. The real Chat owner must keep it expired.
		return a.Authorize(ctx, retained)
	}))
	f.physical.account = accountSendSnapshot()
	chatAccountAuthorizationPrepare(t, f, input.Binding)
	if err := h.Send(ctx, 10000); err != nil || retained == nil || f.physical.sends != 1 {
		t.Fatal("first private capability", retained, err)
	}
	if err := a.Authorize(ctx, retained); err == nil || err.Error() != "chat_account_unavailable" {
		t.Fatal("retained capability authorized outside Send", err)
	}
	inspected := false
	if err := retained.WithCurrent(ctx, func(*conversation.Binding) error { inspected = true; return nil }); err == nil || inspected {
		t.Fatal("expired capability reached live Chat inspection", err)
	}
	if snapshot, err := retained.AccountSnapshot(ctx); err == nil || snapshot != nil {
		t.Fatal("expired capability retained live account evidence", snapshot, err)
	}
	chatAccountAuthorizationFinish(t, h)
	next := input
	next.Binding.TurnID, next.Binding.OperationID = "follow-turn", "follow-operation"
	next.Binding.TurnGeneration++
	next.Prompt = "Follow cannot reuse a prior SendCurrent"
	follow, err := f.ingress.facade.Follow(ctx, h, next)
	if err != nil {
		t.Fatal("actual Follow for stale capability probe", err)
	}
	chatAccountAuthorizationPrepare(t, f, next.Binding)
	if err := follow.Send(ctx, 10000); err != nil || calls != 2 {
		t.Fatal("stale capability known settlement", err, calls)
	}
	chatAccountAuthorizationRefused(t, f, follow, next.Binding, 1)
	if calls != 2 {
		t.Fatal("stale capability retried")
	}
}

func TestChatAccountAuthorizationFollowMayReuseOriginalTurnIDAtNewGeneration(t *testing.T) {
	ctx := context.Background()
	f := newChatComputerFixture(t)
	input := chatAccountAuthorizationInput()
	account, _, _ := chatAccountAuthorizationApproval(t, chatAccountAuthorizationScope(input.Binding))
	a := chatAccountAuthorizationCapture(t, account, input)
	calls := 0
	first := chatAccountAuthorizationPromote(t, f, input, chatAccountAuthorizationFunc(func(ctx context.Context, current *conversation.SendCurrent) error {
		calls++
		return a.Authorize(ctx, current)
	}))
	f.physical.account = accountSendSnapshot()
	chatAccountAuthorizationPrepare(t, f, input.Binding)
	if err := first.Send(ctx, 10000); err != nil || f.physical.sends != 1 {
		t.Fatal("first A/gen1/op1 Send", err)
	}
	r1 := chatAccountAuthorizationFinish(t, first)
	secondInput := input
	secondInput.Binding.TurnID, secondInput.Binding.OperationID = "turn-b", "operation-2"
	secondInput.Binding.TurnGeneration++
	secondInput.Prompt = "Second B/gen2/op2 turn"
	second, err := f.ingress.facade.Follow(ctx, first, secondInput)
	if err != nil || second == nil {
		t.Fatal("second actual Facade.Follow", second, err)
	}
	p2 := chatAccountAuthorizationPrepare(t, f, secondInput.Binding)
	if err := second.Send(ctx, 10000); err != nil || f.physical.sends != 2 {
		t.Fatal("second B/gen2/op2 Send", err)
	}
	r2 := chatAccountAuthorizationFinish(t, second)
	thirdInput := input
	// TurnID uniqueness is generation-scoped. A differs from the immediate
	// predecessor B, while the globally consumed OperationID remains fresh.
	thirdInput.Binding.OperationID = "operation-3"
	thirdInput.Binding.TurnGeneration = 3
	thirdInput.Prompt = "Third A/gen3/op3 turn"
	third, err := f.ingress.facade.Follow(ctx, second, thirdInput)
	if err != nil || third == nil {
		t.Fatal("third actual Facade.Follow rejected valid generation-scoped TurnID", third, err)
	}
	p3 := chatAccountAuthorizationPrepare(t, f, thirdInput.Binding)
	if p2.ConversationID != r1.ConversationID || r2.ConversationID != r1.ConversationID || p3.ConversationID != r1.ConversationID {
		t.Fatal("three turns crossed provider conversation", p2, r2, p3)
	}
	if err := third.Send(ctx, 10000); err != nil {
		t.Fatal("third A/gen3/op3 Send settlement", err)
	}
	if f.physical.sends != 3 || calls != 3 {
		refused, err := third.Result(ctx)
		t.Fatalf("valid A/gen3/op3 Follow refused: physical Exchange sends=%d want=3, original-guard calls=%d want=3, result=%+v, result error=%v", f.physical.sends, calls, refused, err)
	}
	r3 := chatAccountAuthorizationFinish(t, third)
	if r3.Binding != thirdInput.Binding || r3.ConversationID != r1.ConversationID {
		t.Fatal("third turn lost stable lineage or conversation", r3)
	}
}

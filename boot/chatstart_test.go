package boot

// Pure composition evidence: the actual Go model resolver, private account
// approval, Chat lifecycle, browser adapter and result store run. Journal
// publication and browser Exchange are injected. These metadata/observation
// fixtures prove no provider, native host, filesystem or installed app behavior.
// No Computer owner, authority, read intent or admission factory is constructed.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

type chatStartFixture struct {
	*chatComputerFixture
	clock         *accountSendClock
	verifications int
	verify        func()
}

func newChatStartFixture(t *testing.T) *chatStartFixture {
	t.Helper()
	f := &chatStartFixture{chatComputerFixture: newChatComputerFixture(t), clock: &accountSendClock{now: 1}}
	f.ingress.accountClock = f.clock
	f.physical.account = accountSendSnapshot()
	f.physical.verifyHook = func() {
		f.verifications++
		if f.verify != nil {
			f.verify()
		}
	}
	return f
}

func chatStartInput() wire.ChatStart {
	// Use only the existing policy/profile data factory. The empty admission is
	// never passed to production, reconstructed, admitted or promoted.
	model := readSelectionInput(wire.ChatComputerAdmissionResponse{})
	observed := accountSendSnapshot()
	return wire.ChatStart{SessionId: "session", Prompt: "Controlled ordinary first turn", Policy: model.Policy, Profiles: model.Profiles, Requested: model.Requested, ConfirmedPrincipalKey: observed.PrincipalKey,
		Observation: wire.BrowserAccountObservation{State: observed.State, Source: observed.Source, PrincipalKey: observed.PrincipalKey, ObservedAtMillis: decimal(observed.ObservedAtMillis), ExpiresAtMillis: decimal(observed.ExpiresAtMillis)}}
}

func (f *chatStartFixture) effects() [4]int {
	return [4]int{f.physical.prepares, f.verifications, f.physical.sends, f.physical.observes}
}

func (f *chatStartFixture) startOrdinary(t *testing.T, operation string) wire.ChatStarted {
	t.Helper()
	out, err := f.ingress.start(context.Background(), operation, chatStartInput())
	if err != nil || out == nil || validateIngress("ChatStarted", out) != nil {
		t.Fatal("compound ordinary start", out, err)
	}
	return *out
}

func (f *chatStartFixture) owned(t *testing.T, h wire.ChatHandle) chatHandle {
	t.Helper()
	actual, err := f.ingress.get(h.HandleId)
	if err != nil || chatWireHandle(actual) != h {
		t.Fatal("exact retained owner", actual, err)
	}
	return actual
}

func (f *chatStartFixture) prepare(t *testing.T, h wire.ChatHandle) chatHandle {
	t.Helper()
	actual := f.owned(t, h)
	p, err := f.ingress.facade.PrepareNext(context.Background(), 10000)
	if err != nil || p == nil || p.Binding != actual.binding {
		t.Fatal("prepare original owner", p, err)
	}
	return actual
}

func chatStartFollowInput(started wire.ChatStarted, previous wire.ChatHandle) wire.ChatCreate {
	return wire.ChatCreate{SessionId: previous.Binding.SessionId, PreviousHandle: &previous.HandleId, Prompt: "Controlled ordinary follow-up", Required: started.Required, Selection: started.Selection, Resolution: started.Resolution}
}

func (f *chatStartFixture) follow(t *testing.T, started wire.ChatStarted, operation string) wire.ChatHandle {
	t.Helper()
	h, err := f.ingress.create(context.Background(), operation, chatStartFollowInput(started, started.Handle))
	if err != nil || h == nil {
		t.Fatal("follow admitted through existing create", h, err)
	}
	return *h
}

func chatStartAssertNoComputer(t *testing.T, f *chatStartFixture, h chatHandle) {
	t.Helper()
	for _, kind := range []string{"promote-conversation", "request-computer", "resolve-computer"} {
		if f.count(kind) != 0 {
			t.Fatal("ordinary startup used a Computer/read-intent transition", kind)
		}
	}
	if _, err := h.handle.ComputerContext(context.Background()); err == nil {
		t.Fatal("ordinary tool-disabled turn exposed Computer context")
	}
}

func TestChatStartResolvesApprovesAndFollowsOnlyAfterACKAndSettlement(t *testing.T) {
	ctx := context.Background()
	f := newChatStartFixture(t)
	started := f.startOrdinary(t, "ordinary-start")
	wantSelection := wire.BrowserSelection{Provider: "farol", Alias: "chatgpt", AccountId: strings.Repeat("c", 64), ModelId: "controlled-model", Effort: "low", Mode: "standard"}
	wantResolution := wire.BrowserResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", RequestedMode: "standard", Resolved: wantSelection, ConfigSHA256: "5bf5b497b199cfac19cccadec8ca426f7da9cbbe97b96eeec15364b138809e3e", TranslationId: "configured"}
	if started.Selection != wantSelection || started.Resolution != wantResolution || started.Required != (wire.BrowserRequiredControls{Model: true, Effort: true, Mode: true}) {
		t.Fatal("start did not capture existing Go resolution and approved principal", started)
	}
	b := started.Handle.Binding
	if b.ProfileId != "profile" || b.BackendGeneration != "backend" || b.OwnerId != "owner" || b.SessionId != "session" || b.OperationId != "ordinary-start" || b.TaskEpoch != "1" || b.TurnGeneration != "1" || b.ParticipantId == b.OwnerId || f.count("admit") != 1 || f.count("enqueue") != 1 || f.effects() != [4]int{} {
		t.Fatal("start changed identity or dispatched before admission returned", started, f.effects())
	}
	first := f.owned(t, started.Handle)
	if first.accountOwner == nil {
		t.Fatal("ordinary admission did not retain private account service")
	}
	if revision, err := first.accountOwner.Revision(ctx); err != nil || revision != 1 {
		t.Fatal("ordinary admission lacks actual private approval", revision, err)
	}
	chatStartAssertNoComputer(t, f, first)
	refuseFollow := func(operation string) {
		t.Helper()
		writes, effects, handles := len(f.journal.entries), f.effects(), len(f.ingress.handles)
		out, err := f.ingress.create(ctx, operation, chatStartFollowInput(started, started.Handle))
		if err == nil || out != nil || len(f.journal.entries) != writes || f.effects() != effects || len(f.ingress.handles) != handles {
			t.Fatal("premature Follow admitted/dispatched a successor", operation, out, err)
		}
	}
	refuseFollow("follow-before-send")
	first = f.prepare(t, started.Handle)
	if err := first.send(ctx, 10000); err != nil || f.physical.sends != 1 || f.verifications != 1 {
		t.Fatal("approved first Send", err, f.effects())
	}
	for range 2 {
		if err := first.handle.Observe(ctx, 10000); err != nil {
			t.Fatal("useful injected output", err)
		}
	}
	frames, err := first.handle.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	useful := false
	for _, frame := range frames {
		if frame.Type == "response.completed" {
			t.Fatal("partial output fabricated completion")
		}
		useful = useful || frame.Type == "response.output_text.delta" && strings.Contains(string(frame.JSON), "Useful before tool.")
	}
	if !useful {
		t.Fatal("first turn had no useful output before completion")
	}
	refuseFollow("follow-before-completion")
	for range 2 {
		if err := first.handle.Observe(ctx, 10000); err != nil {
			t.Fatal(err)
		}
	}
	result, err := first.handle.Result(ctx)
	if err != nil || result == nil || !result.Complete || result.Acknowledged || result.Outcome != "completed" || result.Text != "Useful before tool. Continued after read." || result.Requested != chatSelection(wantSelection) {
		t.Fatal("useful first result", result, err)
	}
	refuseFollow("follow-before-ack")
	if err := first.handle.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	refuseFollow("follow-before-settlement")
	if err := first.handle.Observe(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	state := readChatStateFixture(t, f.ingress, started.Handle)
	if !state.FollowReady || !state.DeliveryAcknowledged || !state.LifecycleSettled || !state.Released {
		t.Fatal("first turn not settled", state)
	}
	secondWire := f.follow(t, started, "ordinary-follow")
	second := f.prepare(t, secondWire)
	if second.accountOwner != first.accountOwner {
		t.Fatal("Follow did not inherit original account service")
	}
	old, next := first.binding, second.binding
	if old.ProfileID != next.ProfileID || old.BackendGeneration != next.BackendGeneration || old.OwnerID != next.OwnerID || old.SessionID != next.SessionID || old.TaskID != next.TaskID || old.TaskEpoch != next.TaskEpoch || old.ParticipantID != next.ParticipantID || old.TurnID == next.TurnID || next.OperationID != "ordinary-follow" || next.TurnGeneration != old.TurnGeneration+1 {
		t.Fatal("Follow replaced conversation identity", old, next)
	}
	if err := second.send(ctx, 10000); err != nil {
		t.Fatal("inherited approval rejected matching Follow", err)
	}
	secondResult := chatAccountAuthorizationFinish(t, second.handle)
	if secondResult.ConversationID != result.ConversationID || secondResult.Text != result.Text || f.physical.sends != 2 || f.verifications != 2 || f.count("admit") != 2 {
		t.Fatal("Follow did not continue same conversation exactly once", secondResult, f.effects())
	}
	writes, effects := len(f.journal.entries), f.effects()
	for _, h := range []chatHandle{first, second} {
		if err := h.send(ctx, 10000); err == nil {
			t.Fatal("completed turn sent twice")
		}
		chatStartAssertNoComputer(t, f, h)
	}
	if out, err := f.ingress.create(ctx, "branch-from-old-handle", chatStartFollowInput(started, started.Handle)); err == nil || out != nil {
		t.Fatal("old predecessor minted another successor", out, err)
	}
	retained, err := first.handle.Result(ctx)
	if err != nil || retained.Text != result.Text || retained.ConversationID != result.ConversationID || !retained.Acknowledged || f.effects() != effects || len(f.journal.entries) != writes {
		t.Fatal("history/replay changed first result or effects", retained, err)
	}
}

func TestChatStartResolvesConfiguredAliasAndEffortTranslation(t *testing.T) {
	f := newChatStartFixture(t)
	in := chatStartInput()
	alias, effort := "ordinary", "careful"
	in.Policy.Harnesses[0].DefaultModel = alias
	in.Policy.Harnesses[0].Models[0].Alias = alias
	in.Requested.Model, in.Requested.Effort = &alias, &effort
	in.Profiles[0].Efforts = append(in.Profiles[0].Efforts, wire.ChatModelEffort{Requested: effort, Resolved: "low"})
	out, err := f.ingress.start(context.Background(), "translated-start", in)
	// Independent canonical bytes for this explicit injected policy fixture.
	digest := sha256.Sum256([]byte(`["farol-task-policy/1","browser",[["browser","ordinary",[["ordinary","controlled-model","low"]]]]]`))
	if err != nil || out == nil || out.Resolution.RequestedAlias != alias || out.Resolution.RequestedEffort != effort || out.Resolution.ConfigSHA256 != hex.EncodeToString(digest[:]) || out.Selection.Alias != "chatgpt" || out.Selection.Effort != "low" || out.Selection.ModelId != in.Profiles[0].ModelId || out.Resolution.Resolved != out.Selection || out.Required != in.Profiles[0].Required || f.count("admit") != 1 || f.effects() != [4]int{} {
		t.Fatal("configured alias/effort bypassed actual resolver", out, err)
	}
}

func TestChatStartCapturesDetachedSelectionAndPrivateApproval(t *testing.T) {
	f := newChatStartFixture(t)
	in := chatStartInput()
	out, err := f.ingress.start(context.Background(), "detached-start", in)
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	original := *out
	in.ConfirmedPrincipalKey, in.Observation.PrincipalKey = strings.Repeat("d", 64), strings.Repeat("d", 64)
	in.Policy.Harnesses[0].Models[0].Model = "changed-config"
	in.Profiles[0].ModelId = "changed-profile"
	*in.Requested.Effort = "high"
	out.Selection.AccountId, out.Selection.ModelId = strings.Repeat("d", 64), "changed-output"
	out.Resolution.Resolved = out.Selection
	out.Required.Model = false
	h := f.prepare(t, original.Handle)
	if err := h.send(context.Background(), 10000); err != nil || f.physical.sends != 1 {
		t.Fatal("caller mutation changed captured approval/selection", err)
	}
	r := chatAccountAuthorizationFinish(t, h.handle)
	if r.Requested != chatSelection(original.Selection) || r.Evidence.Resolution != chatResolution(original.Resolution) {
		t.Fatal("admitted owner retained caller-owned metadata", r)
	}
	chatStartAssertNoComputer(t, f, h)
}

func TestChatStartRejectsAccountBeforeJournalAdmission(t *testing.T) {
	for _, fault := range []string{"stale", "expired", "future", "too-old", "wrong-principal", "unknown", "wrong-source", "missing-confirmation", "missing-observation", "invalid-expiry"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatStartFixture(t)
			in := chatStartInput()
			switch fault {
			case "stale", "expired":
				f.clock.now = 100
			case "future":
				in.Observation.ObservedAtMillis = "2"
			case "too-old":
				f.clock.now, in.Observation.ExpiresAtMillis = 5002, "10000"
			case "wrong-principal":
				in.ConfirmedPrincipalKey = strings.Repeat("d", 64)
			case "unknown":
				in.Observation.State = "unknown"
			case "wrong-source":
				in.Observation.Source = "unqualified-source"
			case "missing-confirmation":
				in.ConfirmedPrincipalKey = ""
			case "missing-observation":
				in.Observation = wire.BrowserAccountObservation{}
			case "invalid-expiry":
				in.Observation.ExpiresAtMillis = "1"
			}
			out, err := f.ingress.start(context.Background(), "invalid-account", in)
			if err == nil || out != nil || len(f.journal.entries) != 0 || len(f.ingress.handles) != 0 || f.effects() != [4]int{} {
				t.Fatal("unapproved account reached Chat admission/browser", out, err, f.effects())
			}
		})
	}
}

func TestChatStartRejectsModelMetadataBeforeJournalAdmission(t *testing.T) {
	for _, fault := range []string{"duplicate-harness", "duplicate-model", "duplicate-profile", "ambiguous-profile", "duplicate-effort", "unsupported-runtime", "unsupported-harness", "unsupported-effort", "wrong-mode", "connector", "missing-policy", "missing-profiles"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatStartFixture(t)
			in := chatStartInput()
			switch fault {
			case "duplicate-harness":
				in.Policy.Harnesses = append(in.Policy.Harnesses, in.Policy.Harnesses[0])
			case "duplicate-model":
				h := &in.Policy.Harnesses[0]
				h.Models = append(h.Models, h.Models[0])
			case "duplicate-profile", "ambiguous-profile":
				p := in.Profiles[0]
				if fault == "ambiguous-profile" {
					p.Id = "another-profile"
				}
				in.Profiles = append(in.Profiles, p)
			case "duplicate-effort":
				in.Profiles[0].Efforts = append(in.Profiles[0].Efforts, in.Profiles[0].Efforts[0])
			case "unsupported-runtime":
				in.Policy.Harnesses[0].Models[0].Model = "unsupported"
			case "unsupported-harness":
				in.Profiles[0].Executor = "unsupported"
			case "unsupported-effort":
				*in.Requested.Effort = "ultra"
			case "wrong-mode":
				*in.Requested.Mode = "pro"
			case "connector":
				in.Profiles[0].Required.Connector = true
			case "missing-policy":
				in.Policy = wire.ChatModelPolicy{}
			case "missing-profiles":
				in.Profiles = nil
			}
			out, err := f.ingress.start(context.Background(), "invalid-model", in)
			if err == nil || out != nil || len(f.journal.entries) != 0 || len(f.ingress.handles) != 0 || f.effects() != [4]int{} {
				t.Fatal("unsupported/duplicate metadata reached admission/browser", out, err, f.effects())
			}
		})
	}
}

func TestChatStartFinalAccountMismatchPreventsOriginalAndSuccessorSend(t *testing.T) {
	for _, turn := range []string{"first", "follow"} {
		for _, fault := range []string{"principal", "unknown", "source", "expired-approval", "expired-observation"} {
			t.Run(turn+"/"+fault, func(t *testing.T) {
				f := newChatStartFixture(t)
				started := f.startOrdinary(t, "account-start")
				target, sends := started.Handle, 0
				if turn == "follow" {
					first := f.prepare(t, target)
					if err := first.send(context.Background(), 10000); err != nil {
						t.Fatal(err)
					}
					chatAccountAuthorizationFinish(t, first.handle)
					target, sends = f.follow(t, started, "account-follow"), 1
				}
				h := f.prepare(t, target)
				f.verify = func() {
					switch fault {
					case "principal":
						f.physical.account.PrincipalKey = strings.Repeat("d", 64)
					case "unknown":
						f.physical.account.State = "unknown"
					case "source":
						f.physical.account.Source = "unqualified-source"
					case "expired-approval":
						f.clock.now = 100
					case "expired-observation":
						f.physical.account.ExpiresAtMillis = 1
					}
				}
				verifies := f.verifications
				if err := h.send(context.Background(), 10000); err != nil {
					t.Fatal("known final refusal did not settle", err)
				}
				chatAccountAuthorizationRefused(t, f.chatComputerFixture, h.handle, h.binding, sends)
				if f.verifications != verifies+1 || f.physical.sends != sends {
					t.Fatal("fresh account mismatch disclosed or verified twice", f.effects())
				}
				chatStartAssertNoComputer(t, f, h)
			})
		}
	}
}

func TestChatStartRevokeAnyHandleHasNoBrowserIOAndPreventsSend(t *testing.T) {
	for _, revokeVia := range []string{"first-before-send", "first-after-follow", "successor"} {
		t.Run(revokeVia, func(t *testing.T) {
			ctx := context.Background()
			f := newChatStartFixture(t)
			started := f.startOrdinary(t, "revoke-start")
			first := f.prepare(t, started.Handle)
			target, selected, sends := first, started.Handle, 0
			if revokeVia != "first-before-send" {
				if err := first.send(ctx, 10000); err != nil {
					t.Fatal(err)
				}
				chatAccountAuthorizationFinish(t, first.handle)
				next := f.follow(t, started, "revoke-follow")
				target, sends = f.prepare(t, next), 1
				if revokeVia == "successor" {
					selected = next
				}
			}
			before := f.effects()
			if err := f.ingress.revokeAccount(ctx, "revoke-account", wire.ChatHandleRequest{HandleId: selected.HandleId}); err != nil || f.effects() != before {
				t.Fatal("account revoke failed or performed browser IO", err, f.effects())
			}
			if err := target.send(ctx, 10000); err != nil {
				t.Fatal("revoked approval did not settle known not-sent result", err)
			}
			chatAccountAuthorizationRefused(t, f.chatComputerFixture, target.handle, target.binding, sends)
			if f.physical.prepares != before[0] || f.verifications != before[1]+1 || f.physical.sends != before[2] || f.physical.observes != before[3] {
				t.Fatal("revoked disclosure performed effects beyond final verification", f.effects())
			}
			writes, effects := len(f.journal.entries), f.effects()
			if target.id != first.id {
				if err := first.send(ctx, 10000); err == nil || f.effects() != effects || len(f.journal.entries) != writes {
					t.Fatal("revocation through successor restored first Send", err)
				}
			}
			if f.physical.sends != sends {
				t.Fatal("revocation added effective Send")
			}
		})
	}
}

func TestChatStartRevocationCannotCrossIndependentOwners(t *testing.T) {
	f := newChatStartFixture(t)
	f.physical.distinctViews = true
	first := f.startOrdinary(t, "independent-first")
	second := f.startOrdinary(t, "independent-second")
	if first.Handle.Binding.TaskId == second.Handle.Binding.TaskId || first.Handle.Binding.ParticipantId == second.Handle.Binding.ParticipantId {
		t.Fatal("independent starts shared a task owner")
	}
	firstOwned := f.prepare(t, first.Handle)
	if err := f.ingress.revokeAccount(context.Background(), "revoke-first", wire.ChatHandleRequest{HandleId: first.Handle.HandleId}); err != nil {
		t.Fatal(err)
	}
	if err := firstOwned.send(context.Background(), 10000); err != nil || f.effects() != [4]int{1, 1, 0, 0} {
		t.Fatal("revoked original disclosed prompt", err, f.effects())
	}
	chatAccountAuthorizationRefused(t, f.chatComputerFixture, firstOwned.handle, firstOwned.binding, 0)
	secondOwned := f.prepare(t, second.Handle)
	if err := secondOwned.send(context.Background(), 10000); err != nil || f.physical.sends != 1 {
		t.Fatal("another conversation inherited foreign revocation", err)
	}
}

func TestChatStartWithdrawalSurvivesAdmissionCapacity(t *testing.T) {
	for _, via := range []string{"original", "successor"} {
		t.Run(via, func(t *testing.T) {
			ctx := context.Background()
			f := newChatStartFixture(t)
			started := f.startOrdinary(t, "capacity-start")
			first := f.prepare(t, started.Handle)
			if err := first.send(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			chatAccountAuthorizationFinish(t, first.handle)
			next := f.follow(t, started, "capacity-follow")
			target := f.prepare(t, next)
			selected := started.Handle
			if via == "successor" {
				selected = next
			}
			invalid := chatStartInput()
			invalid.Profiles[0].Executor = "unsupported"
			for n := range 1024 {
				if out, err := f.ingress.start(ctx, fmt.Sprintf("capacity-invalid-%d", n), invalid); err == nil || out != nil {
					t.Fatal("invalid model admitted", out, err)
				}
			}
			// Start requires a new withdrawal slot too. Fill any final ordinary
			// slot with a refused legacy follow before testing its capacity fence.
			badPrevious := "missing-previous"
			legacy := chatComputerInput(false)
			legacy.PreviousHandle = &badPrevious
			if out, err := f.ingress.create(ctx, "capacity-invalid-legacy", legacy); err == nil || out != nil {
				t.Fatal("unknown legacy predecessor admitted", out, err)
			}
			// Legacy creation shares the budget and cannot consume withdrawal slots.
			if out, err := f.ingress.create(ctx, "capacity-legacy", chatComputerInput(false)); err == nil || out != nil {
				t.Fatal("legacy creation bypassed reserved capacity", out, err)
			}
			before := f.effects()
			request := wire.ChatHandleRequest{HandleId: selected.HandleId}
			if err := f.ingress.revokeAccount(ctx, "capacity-withdraw", request); err != nil || f.effects() != before {
				t.Fatal("admission capacity prevented withdrawal", err, f.effects())
			}
			if err := f.ingress.revokeAccount(ctx, "capacity-withdraw", request); err == nil {
				t.Fatal("duplicate withdrawal operation accepted")
			}
			if err := target.send(ctx, 10000); err != nil {
				t.Fatal(err)
			}
			chatAccountAuthorizationRefused(t, f.chatComputerFixture, target.handle, target.binding, 1)
			if f.physical.sends != before[2] || len(f.ingress.used) > 1024 {
				t.Fatal("withdrawal disclosed or exceeded bounded ledger", f.effects(), len(f.ingress.used))
			}
		})
	}
}

func TestChatStartDuplicateOperationIncludingLostJournalOutcomeNeverCreatesSecondOwner(t *testing.T) {
	for _, lost := range []string{"", "admit", "enqueue"} {
		t.Run("lost-"+lost, func(t *testing.T) {
			f := newChatStartFixture(t)
			f.journal.fail = lost
			first, err := f.ingress.start(context.Background(), "start-once", chatStartInput())
			if lost == "" && (err != nil || first == nil) || lost != "" && (err == nil || first != nil) {
				t.Fatal("start outcome was misclassified", first, err)
			}
			writes, handles := len(f.journal.entries), len(f.ingress.handles)
			f.journal.fail = ""
			for _, changed := range []bool{false, true} {
				in := chatStartInput()
				if changed {
					in.Prompt = "Replacement must not replay lost admission"
				}
				out, err := f.ingress.start(context.Background(), "start-once", in)
				if err == nil || out != nil || len(f.journal.entries) != writes || len(f.ingress.handles) != handles || f.count("admit") != 1 || f.effects() != [4]int{} {
					t.Fatal("duplicate/unknown start minted another owner", out, err)
				}
			}
			if out, err := f.ingress.create(context.Background(), "start-once", chatComputerInput(false)); err == nil || out != nil || len(f.journal.entries) != writes || len(f.ingress.handles) != handles || f.effects() != [4]int{} {
				t.Fatal("legacy create bypassed consumed start operation", out, err)
			}
		})
	}
}

func TestChatStartNilCancelledAndCrossedCallsHaveNoEffects(t *testing.T) {
	var absent *ChatIngress
	if out, err := absent.start(context.Background(), "nil-owner", chatStartInput()); err == nil || out != nil {
		t.Fatal("nil ingress accepted start", out, err)
	}
	if err := absent.revokeAccount(context.Background(), "nil-owner", wire.ChatHandleRequest{HandleId: "unknown"}); err == nil {
		t.Fatal("nil ingress accepted revoke")
	}
	for _, fault := range []string{"nil-context", "cancelled", "empty-operation", "empty-session", "empty-prompt"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatStartFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var selected context.Context = ctx
			in, operation := chatStartInput(), "invalid-call"
			switch fault {
			case "nil-context":
				selected = nil
			case "cancelled":
				cancel()
			case "empty-operation":
				operation = ""
			case "empty-session":
				in.SessionId = ""
			case "empty-prompt":
				in.Prompt = ""
			}
			out, err := f.ingress.start(selected, operation, in)
			if err == nil || out != nil || len(f.journal.entries) != 0 || len(f.ingress.handles) != 0 || f.effects() != [4]int{} {
				t.Fatal("invalid call admitted/dispatched", out, err)
			}
		})
	}
	f := newChatStartFixture(t)
	started := f.startOrdinary(t, "crossed-start")
	writes := len(f.journal.entries)
	for n, ctx := range []context.Context{nil, context.Background()} {
		if err := f.ingress.revokeAccount(ctx, fmt.Sprintf("unknown-revoke-%d", n), wire.ChatHandleRequest{HandleId: "unknown"}); err == nil {
			t.Fatal("nil/crossed revoke accepted")
		}
	}
	if _, err := f.ingress.create(context.Background(), "crossed-session-follow", func() wire.ChatCreate {
		in := chatStartFollowInput(started, started.Handle)
		in.SessionId = "another-session"
		return in
	}()); err == nil || len(f.journal.entries) != writes || f.effects() != [4]int{} {
		t.Fatal("crossed predecessor admitted", err)
	}
	h := f.prepare(t, started.Handle)
	if err := h.send(context.Background(), 10000); err != nil || f.physical.sends != 1 {
		t.Fatal("invalid revoke withdrew another owner", err)
	}
}

func chatStartWireCall(t *testing.T, s *ChatIngress, method, operation string, body any) (*desktop.Outcome, error) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	route, exists := s.Methods()[method]
	if !exists || route.Handle == nil {
		t.Fatal("compound Chat wire route missing", method)
	}
	return route.Handle(context.Background(), desktop.Request{RequestID: "chat-start-test", OperationID: operation, Body: raw})
}

func TestChatStartWireRoutesReturnChatStartedAndEmpty(t *testing.T) {
	f := newChatStartFixture(t)
	out, err := chatStartWireCall(t, f.ingress, "chat.conversation.start", "wire-start", chatStartInput())
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ChatStarted", out.Data) != nil {
		t.Fatal("start wire response", out, err)
	}
	var started wire.ChatStarted
	if err := json.Unmarshal(out.Data, &started); err != nil {
		t.Fatal(err)
	}
	if started.Selection.AccountId != chatStartInput().ConfirmedPrincipalKey || started.Resolution.Resolved != started.Selection || f.count("admit") != 1 || f.effects() != [4]int{} {
		t.Fatal("wire start lost capture or sent", started)
	}
	h := f.prepare(t, started.Handle)
	before := f.effects()
	out, err = chatStartWireCall(t, f.ingress, "chat.conversation.account.revoke", "wire-revoke", wire.ChatHandleRequest{HandleId: started.Handle.HandleId})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("Empty", out.Data) != nil || f.effects() != before {
		t.Fatal("revoke wire response", out, err)
	}
	if err := h.send(context.Background(), 10000); err != nil {
		t.Fatal("wire revoke did not settle known not-sent result", err)
	}
	chatAccountAuthorizationRefused(t, f.chatComputerFixture, h.handle, h.binding, 0)
	if f.effects() != [4]int{before[0], before[1] + 1, before[2], before[3]} {
		t.Fatal("wire revoke permitted effective Send", f.effects())
	}
}

func TestChatStartWireRejectsMissingAndCrossedEnvelopesBeforeEffects(t *testing.T) {
	for _, method := range []string{"chat.conversation.start", "chat.conversation.account.revoke"} {
		for _, fault := range []string{"missing-operation", "null", "crossed-shape", "extra-authority"} {
			t.Run(method+"/"+fault, func(t *testing.T) {
				f := newChatStartFixture(t)
				operation := "wire-invalid"
				var body any = chatStartInput()
				if method == "chat.conversation.account.revoke" {
					body = wire.ChatHandleRequest{HandleId: "unknown"}
				}
				switch fault {
				case "missing-operation":
					operation = ""
				case "null":
					body = nil
				case "crossed-shape":
					if method == "chat.conversation.start" {
						body = wire.ChatHandleRequest{HandleId: "unknown"}
					} else {
						body = chatStartInput()
					}
				case "extra-authority":
					raw, _ := json.Marshal(body)
					var fields map[string]any
					if err := json.Unmarshal(raw, &fields); err != nil {
						t.Fatal(err)
					}
					fields["admission"] = wire.ChatComputerAdmissionResponse{}
					body = fields
				}
				out, err := chatStartWireCall(t, f.ingress, method, operation, body)
				if err == nil && (out == nil || out.Status == "ok") || len(f.journal.entries) != 0 || len(f.ingress.handles) != 0 || f.effects() != [4]int{} {
					t.Fatal("invalid/crossed wire envelope reached owner/browser", out, err)
				}
			})
		}
	}
}

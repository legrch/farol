package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	app "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

const codecProviderCID = "fixture-provider-conversation"
const codecFixturePrompt = "fixture transient prompt"
const codecFixtureAnswer = "fixture transient answer"

// Real Service and Repository, CPU-only storage/browser doubles. These fixtures
// prove codec/lifecycle parity, never DOM controls, native durability or recovery.
type providerCodecBrowser struct {
	exactBrowser
	sends int
}

func (*providerCodecBrowser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	b := port.BrowserBinding{ProviderState: port.ProviderHome, Lease: r.Lease, ViewID: "fixture-view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration}
	saved := r.Target.Mode == port.OwnedSaved
	if saved {
		b.ProviderState, b.ConversationID = port.ProviderBound, r.Target.ConversationID
	}
	return &port.PrepareResponse{Binding: b, Saved: saved, Readiness: port.Ready}, nil
}
func (*providerCodecBrowser) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	return &port.SendVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, IntentDigest: r.IntentDigest, EvidenceID: "fixture-verification-" + r.Binding.Lease.Identity.OperationID, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, Observed: port.SelectionFacts{
		ObservedAtMillis: 42,
		Model:            port.ControlFact{Value: "fixture-model", Literal: "Fixture model", Source: port.FactPublicControl},
		Effort:           port.ControlFact{Value: "low", Literal: "Low", Source: port.FactPublicControl},
	}}, nil
}
func (b *providerCodecBrowser) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.sends++
	return &port.SendResponse{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: port.Submitted}, nil
}
func (*providerCodecBrowser) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	e := port.BrowserObservation{Binding: r.Binding, Sequence: r.AfterSequence + 1, UserTurnID: "user-" + r.Binding.Lease.Identity.OperationID}
	switch r.AfterSequence {
	case 0:
		e.Kind = port.Accepted
		if r.Binding.ProviderState == port.ProviderHome {
			e.ProviderConversationID = codecProviderCID
		}
	case 1:
		e.Kind, e.ReplyID, e.SegmentID, e.Text = port.AnswerDelta, "reply-"+r.Binding.Lease.Identity.OperationID, "fixture-segment", codecFixtureAnswer
	case 2:
		e.Kind, e.ReplyID = port.Completed, "reply-"+r.Binding.Lease.Identity.OperationID
	case 3:
		e.Kind, e.ReplyID = port.Quiescent, "reply-"+r.Binding.Lease.Identity.OperationID
	default:
		return &port.ObserveResponse{}, nil
	}
	return &port.ObserveResponse{Events: []port.BrowserObservation{e}}, nil
}

func homeCodecOwner(t *testing.T) (*Repository, *physicalFixture, *app.Service, *providerCodecBrowser, *app.Conversation, port.ConversationInput) {
	t.Helper()
	ctx := context.Background()
	p := &physicalFixture{}
	r, err := claimFixture(t, p)
	if err != nil {
		t.Fatal(err)
	}
	browser := &providerCodecBrowser{}
	s, err := app.New(ctx, scope, app.Dependencies{Gate: gate.New(), Journal: r, Browser: browser, Results: exactResults{}, ResultBytesLimit: app.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	i := port.ConversationInput{Binding: binding(), Required: port.RequiredControls{Model: true, Effort: true}, Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "fixture-account", ModelID: "fixture-model", Effort: "low"}, Prompt: codecFixturePrompt}
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := s.PrepareNext(ctx, 100)
	if err != nil || prepared == nil || prepared.ProviderState != port.ProviderHome || prepared.ConversationID != "" {
		t.Fatal("new conversation did not prepare exact home", prepared, err)
	}
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal("fixture Send precondition", err)
	}
	return r, p, s, browser, c, i
}

func codecRoundtrip(t *testing.T, r *Repository, p *physicalFixture) record {
	t.Helper()
	stored, err := decode(p.raw, r.owner.limits)
	if err != nil {
		t.Fatal("stored transition replay", err)
	}
	raw, err := encode(stored, r.owner.limits)
	if err != nil || !bytes.Equal(raw, p.raw) {
		t.Fatal("codec roundtrip changed metadata", err)
	}
	if bytes.Contains(raw, []byte(codecFixturePrompt)) || bytes.Contains(raw, []byte(codecFixtureAnswer)) {
		t.Fatal("transient content entered journal")
	}
	return stored
}

func completeCodecConversation(t *testing.T, c *app.Conversation) {
	t.Helper()
	ctx := context.Background()
	// Accepted was already observed; delta, completion and quiescence follow.
	for n := 0; n < 3; n++ {
		if err := c.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	result, err := c.Result(ctx)
	if err != nil || result == nil || !result.Complete || result.ProviderConversationID != codecProviderCID || result.Text != codecFixtureAnswer {
		t.Fatal("bound result lost identity/content", result, err)
	}
	if err := c.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
}

func TestHomeAcceptedJournalRoundtripAndBoundFollowup(t *testing.T) {
	r, p, s, browser, first, input := homeCodecOwner(t)
	ctx := context.Background()
	if err := first.Observe(ctx, 100); err != nil {
		t.Fatal("home Accepted publication", err)
	}
	stored := codecRoundtrip(t, r, p)
	accepted := stored.Writes[len(stored.Writes)-1].Entry
	expected := accepted.Before.Binding
	expected.Document.ProviderState, expected.Document.ConversationID = turn.ProviderBound, codecProviderCID
	if accepted.Kind != "accept" || accepted.Before.Binding.Document.ProviderState != turn.ProviderHome || accepted.Before.Binding.Document.ConversationID != "" || accepted.After.Binding != expected || !accepted.After.Accepted {
		t.Fatal("accept did not preserve exact physical binding while adopting CID")
	}
	completeCodecConversation(t, first)
	input.Binding.OperationID, input.Binding.TurnID = "follow-operation", "follow-turn"
	input.Binding.TurnGeneration++
	second, err := s.FollowConversation(ctx, first, input)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := s.PrepareNext(ctx, 100)
	if err != nil || prepared == nil || prepared.ProviderState != port.ProviderBound || prepared.ConversationID != codecProviderCID {
		t.Fatal("followup lost adopted CID", prepared, err)
	}
	if err := second.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := second.Observe(ctx, 100); err != nil {
		t.Fatal("already-bound followup Accepted", err)
	}
	stored = codecRoundtrip(t, r, p)
	follow := stored.Writes[len(stored.Writes)-1].Entry
	if follow.Kind != "accept" || follow.Before.Binding != follow.After.Binding || follow.After.Binding.Document.ConversationID != codecProviderCID {
		t.Fatal("bound acceptance changed provider identity")
	}
	changedFollow := stored
	changedFollow.Writes = append([]port.JournalWrite(nil), stored.Writes...)
	changedFollow.Writes[len(changedFollow.Writes)-1].Entry.After.Binding.Document.ConversationID = "other-provider-cid"
	assertInvalidProviderRecord(t, changedFollow, r.owner.limits)
	completeCodecConversation(t, second)
	proof, err := s.Retire(ctx)
	if err != nil || proof == nil {
		t.Fatal("CPU retirement validation", err)
	}
	stored = codecRoundtrip(t, r, p)
	if stored.Retirement == nil || len(stored.Retirement.Turns) != 2 || browser.sends != 2 {
		t.Fatal("followup/retirement did not preserve both turns")
	}
	for _, retained := range stored.Retirement.Turns {
		if retained.Snapshot.Binding.Document.ProviderState != turn.ProviderBound || retained.Snapshot.Binding.Document.ConversationID != codecProviderCID || retained.Quiescence.Binding != retained.Snapshot.Binding || retained.AcknowledgedRevision == 0 || retained.ReleasedRevision == 0 {
			t.Fatal("decoded retirement lost original bound witnesses")
		}
	}
	// Decoding is validation only: no historical handle or restore admission.
	if _, err := r.OpenFresh(ctx, scope); err == nil {
		t.Fatal("decoded history reopened a retired owner")
	}
}

func TestHomeAcceptedCodecRejectsForgedBindingAndLifecycleChanges(t *testing.T) {
	r, p, _, _, c, _ := homeCodecOwner(t)
	if err := c.Observe(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	original := codecRoundtrip(t, r, p)
	cases := map[string]func(*port.JournalEntry){
		"view":                func(e *port.JournalEntry) { e.After.Binding.Document.ViewID = "other-view" },
		"view-generation":     func(e *port.JournalEntry) { e.After.Binding.Document.ViewGeneration++ },
		"document-generation": func(e *port.JournalEntry) { e.After.Binding.Document.DocumentGeneration++ },
		"slot":                func(e *port.JournalEntry) { e.After.Binding.Reservation.Ordinal++ },
		"slot-generation":     func(e *port.JournalEntry) { e.After.Binding.Reservation.Generation++ },
		"backend":             func(e *port.JournalEntry) { e.After.Binding.Reservation.BackendGeneration = "other-backend" },
		"turn":                func(e *port.JournalEntry) { e.After.Binding.Reservation.Identity.TurnID = "other-turn" },
		"turn-generation":     func(e *port.JournalEntry) { e.After.Binding.Reservation.Identity.Generation++ },
		"reservation":         func(e *port.JournalEntry) { e.After.Reservation.Generation++ },
		"logical-identity":    func(e *port.JournalEntry) { e.After.Identity.OperationID = "other-operation" },
		"missing-cid":         func(e *port.JournalEntry) { e.After.Binding.Document.ConversationID = "" },
		"malformed-cid":       func(e *port.JournalEntry) { e.After.Binding.Document.ConversationID = "invalid cid" },
		"still-home":          func(e *port.JournalEntry) { e.After.Binding.Document.ProviderState = turn.ProviderHome },
		"implicit-bound":      func(e *port.JournalEntry) { e.After.Binding.Document.ProviderState = "" },
		"unknown-state":       func(e *port.JournalEntry) { e.After.Binding.Document.ProviderState = "other" },
		"not-accepted":        func(e *port.JournalEntry) { e.After.Accepted = false },
		"not-dispatched":      func(e *port.JournalEntry) { e.After.SendIntent = false },
		"phase":               func(e *port.JournalEntry) { e.After.Phase = turn.Pending },
		"result":              func(e *port.JournalEntry) { e.After.HasResult = true },
		"old-document":        func(e *port.JournalEntry) { e.Before.Binding.Document.DocumentGeneration++ },
		"changed-authority":   func(e *port.JournalEntry) { e.Binding.TaskEpoch++ },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			changed := original
			changed.Writes = append([]port.JournalWrite(nil), original.Writes...)
			mutate(&changed.Writes[len(changed.Writes)-1].Entry)
			assertInvalidProviderRecord(t, changed, r.owner.limits)
		})
	}
	for _, cid := range []string{codecProviderCID, "second-provider-cid"} {
		t.Run("repeated-accept-"+cid, func(t *testing.T) {
			changed := original
			last := original.Writes[len(original.Writes)-1]
			last.PreviousRevision, last.Revision = last.Revision, last.Revision+1
			last.Entry.Before = last.Entry.After
			last.Entry.After.Binding.Document.ConversationID = cid
			changed.Writes = append(append([]port.JournalWrite(nil), original.Writes...), last)
			assertInvalidProviderRecord(t, changed, r.owner.limits)
		})
	}
	t.Run("accept-before-send", func(t *testing.T) {
		changed := original
		for n, w := range original.Writes {
			if w.Entry.Kind != "prepared" {
				continue
			}
			last := original.Writes[len(original.Writes)-1]
			last.PreviousRevision, last.Revision = w.Revision, w.Revision+1
			last.Entry.Before = w.Entry.After
			changed.Writes = append(append([]port.JournalWrite(nil), original.Writes[:n+1]...), last)
			assertInvalidProviderRecord(t, changed, r.owner.limits)
			return
		}
		t.Fatal("fixture has no prepared transition")
	})
	t.Run("post-accept-cid-change", func(t *testing.T) {
		if err := c.Observe(context.Background(), 100); err != nil {
			t.Fatal(err)
		}
		changed := codecRoundtrip(t, r, p)
		last := &changed.Writes[len(changed.Writes)-1].Entry
		if last.Kind != "delta" {
			t.Fatal("fixture has no bound delta")
		}
		last.Before.Binding.Document.ConversationID = "other-provider-cid"
		last.After.Binding.Document.ConversationID = "other-provider-cid"
		assertInvalidProviderRecord(t, changed, r.owner.limits)
	})
}

func assertInvalidProviderRecord(t *testing.T, changed record, limits Limits) {
	t.Helper()
	if _, err := encode(changed, limits); !errors.Is(err, Invalid) {
		t.Fatal("forged transition encoded", err)
	}
	// Marshal canonical-shaped hostile input directly, bypassing encode validation.
	raw, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decode(raw, limits); !errors.Is(err, Invalid) {
		t.Fatal("forged transition decoded", err)
	}
}

func TestHomeAcceptedLostJournalReplyRetainsCIDWithoutDuplicateSend(t *testing.T) {
	r, p, _, browser, c, _ := homeCodecOwner(t)
	p.replaceFault = true
	if err := c.Observe(context.Background(), 100); !errors.Is(err, app.Unsettled) {
		t.Fatal("lost journal reply became known acceptance", err)
	}
	published := codecRoundtrip(t, r, p)
	last := published.Writes[len(published.Writes)-1].Entry
	if last.Kind != "accept" || last.After.Binding.Document.ConversationID != codecProviderCID {
		t.Fatal("lost reply discarded published CID")
	}
	replaces := p.replaces
	if err := c.Send(context.Background(), 100); !errors.Is(err, app.Unsettled) || browser.sends != 1 || p.replaces != replaces {
		t.Fatal("unknown acceptance retried effect/publication", err)
	}
	if err := c.WithConversation(context.Background(), func(port.ConversationState) error {
		t.Fatal("unknown acceptance exposed known provider ownership")
		return nil
	}); !errors.Is(err, app.Unsettled) {
		t.Fatal("unknown acceptance lost fence", err)
	}
}

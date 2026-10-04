package lifecycle

import (
	"bytes"
	"context"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	app "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

func readIntentCodecOwner(t *testing.T) (*Repository, *physicalFixture, *app.Service, *app.Handle, port.ConversationInput) {
	t.Helper()
	p := &physicalFixture{}
	r, err := claimFixture(t, p)
	if err != nil {
		t.Fatal(err)
	}
	s, err := app.New(context.Background(), scope, app.Dependencies{Gate: gate.New(), Journal: r, Browser: &providerCodecBrowser{}, Results: exactResults{}, ResultBytesLimit: app.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	i := port.ConversationInput{Binding: binding(), Required: port.RequiredControls{Model: true, Effort: true}, Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "fixture-account", ModelID: "fixture-model", Effort: "low"}, Prompt: codecFixturePrompt}
	h, err := s.Admit(context.Background(), i.Binding, digest)
	if err != nil {
		t.Fatal(err)
	}
	return r, p, s, h, i
}

func TestReadIntentCodecPromotionRoundtripAndOriginalAdmission(t *testing.T) {
	r, p, s, h, i := readIntentCodecOwner(t)
	ctx := context.Background()
	admitted := codecRoundtrip(t, r, p).Writes[0]
	c, err := s.PromoteConversation(ctx, h, i)
	if err != nil {
		t.Fatal(err)
	}
	stored := codecRoundtrip(t, r, p)
	if stored.Version != 2 || len(stored.Writes) != 2 || stored.Writes[0] != admitted || stored.Writes[1].Entry.Kind != "promote-conversation" || stored.Writes[1].Entry.IntentDigest == digest || stored.Writes[1].Entry.Binding != admitted.Entry.Binding || stored.Writes[1].Entry.Before.Phase != turn.Admitted || stored.Writes[1].Entry.After.Phase != turn.Pending {
		t.Fatal("promotion rewrote admission/storage version")
	}
	raw := append([]byte(nil), p.raw...)
	if duplicate, err := s.PromoteConversation(ctx, h, i); err != nil || duplicate != c || !bytes.Equal(p.raw, raw) {
		t.Fatal("duplicate wrote journal", err)
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	completeCodecConversation(t, c)
	codecRoundtrip(t, r, p)
}

func TestReadIntentCodecRejectsDuplicatePromotionAndChangedPhase(t *testing.T) {
	r, p, s, h, i := readIntentCodecOwner(t)
	if _, err := s.PromoteConversation(context.Background(), h, i); err != nil {
		t.Fatal(err)
	}
	stored := codecRoundtrip(t, r, p)
	for _, scenario := range []string{"duplicate", "duplicate changed digest", "pending before", "wrong after", "invalid digest", "missing digest", "closed", "effect", "foreign binding", "admission reinterpreted"} {
		t.Run(scenario, func(t *testing.T) {
			bad := stored
			bad.Writes = append([]port.JournalWrite(nil), stored.Writes...)
			e := &bad.Writes[1].Entry
			switch scenario {
			case "duplicate", "duplicate changed digest":
				duplicate := bad.Writes[1]
				duplicate.PreviousRevision, duplicate.Revision = 2, 3
				duplicate.Entry.Before = duplicate.Entry.After
				if scenario == "duplicate changed digest" {
					duplicate.Entry.IntentDigest = digest
				}
				bad.Writes = append(bad.Writes, duplicate)
			case "pending before":
				e.Before.Phase = turn.Pending
			case "wrong after":
				e.After.Phase = turn.Admitted
			case "invalid digest":
				e.IntentDigest = "not-a-digest"
			case "missing digest":
				e.IntentDigest = ""
			case "closed":
				e.Closed = true
			case "effect":
				e.Effect = "send"
			case "foreign binding":
				e.Binding.ParticipantID = "other"
			case "admission reinterpreted":
				e.Kind = "enqueue"
			}
			if _, err := encode(bad, r.owner.limits); err == nil {
				t.Fatal("invalid promotion record accepted")
			}
		})
	}
}

func TestReadIntentCodecWithdrawalAndOldRecordsKeepMeaning(t *testing.T) {
	r, p, s, h, _ := readIntentCodecOwner(t)
	admitted := codecRoundtrip(t, r, p)
	if err := s.WithdrawReadIntent(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	stored := codecRoundtrip(t, r, p)
	if stored.Version != 2 || len(stored.Writes) != 3 || stored.Writes[0] != admitted.Writes[0] || stored.Writes[1].Entry.Kind != "cancel" || stored.Writes[2].Entry.Kind != "acknowledge" || !stored.Writes[2].Entry.After.DeliveryAcknowledged {
		t.Fatal("withdrawal changed codec contract")
	}
	raw := append([]byte(nil), p.raw...)
	if err := s.WithdrawReadIntent(context.Background(), h); err != nil || !bytes.Equal(raw, p.raw) {
		t.Fatal("withdrawal duplicate rewrote storage", err)
	}
	// The preexisting admission + enqueue representation still has no promotion
	// digest. Validation does not infer a conversation from this old record.
	old := admitted
	q, _ := turn.NewQueue(scope.ProfileID, scope.BackendGeneration)
	before, _ := q.Admit(identity(binding()), digest)
	after, _ := q.Enqueue(identity(binding()))
	old.Writes = append(old.Writes, port.JournalWrite{Scope: scope, PreviousRevision: 1, Revision: 2, Entry: port.JournalEntry{Binding: binding(), Kind: "enqueue", Before: before, After: after}})
	encoded, err := encode(old, r.owner.limits)
	if err != nil {
		t.Fatal("old record rejected", err)
	}
	decoded, err := decode(encoded, r.owner.limits)
	if err != nil || decoded.Writes[1].Entry.Kind != "enqueue" || decoded.Writes[1].Entry.IntentDigest != "" {
		t.Fatal("old enqueue reinterpreted", err)
	}
}

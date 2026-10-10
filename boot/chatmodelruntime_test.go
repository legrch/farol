package boot

// Controlled composition of the existing model resolver, private account owner
// and Chat lifecycle. Browser IO and journal persistence are injected.
import (
	"context"
	"strings"
	"testing"
)

func TestChatStartFollowCannotReplaceCapturedModelResolution(t *testing.T) {
	f := newChatStartFixture(t)
	started := f.startOrdinary(t, "model-original")
	first := f.prepare(t, started.Handle)
	if err := first.send(context.Background(), 10000); err != nil {
		t.Fatal(err)
	}
	chatAccountAuthorizationFinish(t, first.handle)
	in := chatStartFollowInput(started, started.Handle)
	// The exact same model/controls can carry a different configuration witness.
	// Follow cannot silently replace the original owner's captured resolution.
	in.Resolution.ConfigSHA256 = strings.Repeat("d", 64)
	writes, effects := len(f.journal.entries), f.effects()
	if out, err := f.ingress.create(context.Background(), "model-crossed-follow", in); err == nil || out != nil {
		t.Fatal("Follow admitted a changed original model resolution", out, err)
	}
	if len(f.journal.entries) != writes || f.effects() != effects {
		t.Fatal("changed resolution published or dispatched", f.effects())
	}
}

func TestChatStartUsesModelsWithOriginalGrantAndFreshFollowObservation(t *testing.T) {
	ctx := context.Background()
	f := newChatStartFixture(t)
	started := f.startOrdinary(t, "model-capture-first")
	first := f.prepare(t, started.Handle)
	if first.browserModel == nil {
		t.Fatal("ordinary startup did not consume the Models adapter")
	}
	original := first.browserModel.original
	pin := original.Resolved().Pin()
	if pin.AccountID != started.Selection.AccountId || pin.Model != started.Selection.ModelId || pin.Effort != started.Selection.Effort || pin.Revision != started.Resolution.ConfigSHA256 || pin.CapabilityRevision != started.Resolution.TranslationId || pin.Epoch != 1 || pin.Route.Backend != "browser-chat" {
		t.Fatal("model policy lost original app/account mapping", pin)
	}
	if err := first.send(ctx, 10000); err != nil {
		t.Fatal(err)
	}
	chatAccountAuthorizationFinish(t, first.handle)
	// The startup observation has expired. A new explicit turn uses newly
	// verified facts, while keeping the SAME private approval and model pin.
	f.clock.now = 200
	f.physical.account.ObservedAtMillis = 200
	f.physical.account.ExpiresAtMillis = 300
	secondWire := f.follow(t, started, "model-capture-follow")
	second := f.prepare(t, secondWire)
	if second.browserModel != first.browserModel || second.accountOwner != first.accountOwner {
		t.Fatal("Follow replaced the original model/account owners")
	}
	if err := second.send(ctx, 10000); err != nil || f.physical.sends != 2 {
		t.Fatal("fresh Follow observation falsely rejected", err, f.effects())
	}
	if revision, err := second.accountOwner.Revision(ctx); err != nil || revision != original.Source().Approval.Revision || second.browserModel.original != original {
		t.Fatal("Follow renewed the approval or changed startup capture", revision, err)
	}
}

func TestChatBrowserModelFinalGateDoesNotRenewPerTurnObservation(t *testing.T) {
	f := newChatStartFixture(t)
	started := f.startOrdinary(t, "model-gate-wait")
	h := f.owned(t, started.Handle)
	m := h.browserModel
	source := m.original.Source()
	check, err := m.forDispatch(source.Approval, source.Observation)
	if err != nil {
		t.Fatal(err)
	}
	f.clock.now = source.Observation.ExpiresAtMillis
	if err := check(); err == nil {
		t.Fatal("final gate wait renewed the original observation")
	}
	if f.effects() != [4]int{} {
		t.Fatal("model correlation performed browser effects")
	}
}

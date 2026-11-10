package access

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	transition "github.com/legrch/farol/modules/computer/domain/journal"
)

var transitionIntent = transition.Request{
	OperationID:   "11111111-1111-4111-8111-111111111111",
	RequestDigest: strings.Repeat("a", 64), ConsentDigest: strings.Repeat("b", 64),
	ProfileID: testBinding.ProfileID, OwnerID: testBinding.OwnerID, ComputerID: testBinding.ComputerID,
	WorkspaceID: "workspace", Root: "/Users/example", ExpectedRevision: "4", ExpectedGeneration: "3",
	BootUUID: "33333333-3333-4333-8333-333333333333", HostLifetimeID: "host-lifetime",
}
var transitionProof = transition.Receipt{EffectID: "native-1", Digest: strings.Repeat("c", 64)}

func TestContinuityFirstIntentDurableBeforeHandlesAndRestoreFences(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	if state, e := f.store.TransitionStatus(ctx); e != nil || state.Present || state.Restricted {
		t.Fatal("legacy changed", e)
	}
	accepted, first, e := f.store.BeginTransition(ctx, transitionIntent)
	if e != nil || !first || accepted.Phase != transition.Intent {
		t.Fatal("first WAL", e)
	}
	if _, e = f.store.Status(ctx); e == nil {
		t.Fatal("current authority exposed during durable intent")
	}
	if e = f.store.AdvanceTransition(ctx, transitionIntent.OperationID, transition.WithdrawIntent, transitionProof); e == nil {
		t.Fatal("withdraw without native preparation")
	}
	existing, again, e := f.store.BeginTransition(ctx, transitionIntent)
	if e != nil || again || existing.Phase != transition.Intent {
		t.Fatal("duplicate dispatched", e)
	}
	restored := restored(t, f)
	observed, e := restored.TransitionStatus(ctx)
	if e != nil || !observed.Present || !observed.Restricted || len(observed.Journal.Entries) != 1 || observed.Delivery != "not_recorded" {
		t.Fatal("lost original after restart", e)
	}
	if _, e = restored.Status(ctx); e == nil {
		t.Fatal("restart bypassed pending WAL")
	}
}
func TestContinuityWALRemovalCorruptionCannotResumeLegacyApproval(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	if _, _, e := f.store.BeginTransition(ctx, transitionIntent); e != nil {
		t.Fatal(e)
	}
	if e := f.store.Close(); e != nil {
		t.Fatal(e)
	}
	if e := os.Remove(filepath.Join(f.root, transitionName)); e != nil {
		t.Fatal(e)
	}
	if s, e := Open(f.root, testBinding, f.clock); e == nil {
		s.Close()
		t.Fatal("missing WAL erased fence")
	}
}
func TestContinuityUnknownBeforeFirstIntentCannotDispatchLater(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	f.store.disk.syncDirectory = func(int) error { return errors.New("disposable sync fault") }
	if _, first, e := f.store.BeginTransition(ctx, transitionIntent); e == nil || first {
		t.Fatal("unknown first intent granted admission")
	}
	if _, _, e := f.store.BeginTransition(ctx, transitionIntent); e == nil {
		t.Fatal("poisoned owner retried uncertain intent")
	}
}
func TestContinuityKnownRefusalDoesNotRenewAnyApproval(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	if _, _, e := f.store.BeginTransition(ctx, transitionIntent); e != nil {
		t.Fatal(e)
	}
	if e := f.store.CertifyTransition(ctx, transitionIntent.OperationID, transition.Refused, transitionProof); e != nil {
		t.Fatal(e)
	}
	if s, e := f.store.TransitionStatus(ctx); e != nil || s.Restricted {
		t.Fatal("known refusal held fence", e)
	}
	if v, e := f.store.Status(ctx); e != nil || v.ApprovalPresent {
		t.Fatal("refusal synthesized approval", e)
	}
}

// A completed WAL certificate alone is not a current startup qualification.
// This source proposal intentionally has NO activation method or RPC.
func TestContinuityCommittedCertificateStillCannotActivateStore(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	approve(t, f)
	r := transitionIntent
	if _, _, err := f.store.BeginTransition(ctx, r); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []transition.Phase{transition.Prepared, transition.WithdrawIntent, transition.WithdrawAcknowledged, transition.SettingsIntent, transition.SettingsAcknowledged, transition.PublishIntent, transition.PublishAcknowledged, transition.CloseIntent, transition.CloseAcknowledged} {
		if err := f.store.AdvanceTransition(ctx, r.OperationID, phase, transitionProof); err != nil {
			t.Fatal(phase, err)
		}
	}
	if err := f.store.CertifyTransition(ctx, r.OperationID, transition.Committed, transitionProof); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("logical certificate activated old persisted approval")
	}
	state, err := f.store.TransitionStatus(ctx)
	if err != nil || !state.Restricted || state.Delivery != "not_recorded" {
		t.Fatal("lost activation fence", err)
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := reopened.Status(ctx); err == nil {
		t.Fatal("restart blessed historical certificate")
	}
}

package access

import (
	"context"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	"testing"
)

func TestPendingContinuityOnlyOriginalIntentCanReadCounters(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	approve(t, f)
	old := status(t, f.store)
	if _, _, err := f.store.BeginTransition(ctx, transitionIntent); err != nil {
		t.Fatal(err)
	}
	if err := f.store.AdvanceTransition(ctx, transitionIntent.OperationID, journal.Prepared, transitionProof); err != nil {
		t.Fatal(err)
	}
	if err := f.store.AdvanceTransition(ctx, transitionIntent.OperationID, journal.WithdrawIntent, transitionProof); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("ordinary read bypassed WAL")
	}
	cases := []struct {
		id      string
		phase   journal.Phase
		receipt journal.Receipt
	}{
		{"wrong", journal.WithdrawIntent, transitionProof},
		{transitionIntent.OperationID, journal.Prepared, transitionProof},
		{transitionIntent.OperationID, journal.WithdrawIntent, journal.Receipt{EffectID: "wrong", Digest: transitionProof.Digest}},
		{transitionIntent.OperationID, journal.SettingsIntent, transitionProof},
	}
	for _, c := range cases {
		if _, err := f.store.TransitionEffectSnapshot(ctx, c.id, c.phase, c.receipt); err == nil {
			t.Fatal("wrong effect accepted", c)
		}
	}
	exact, err := f.store.TransitionEffectSnapshot(ctx, transitionIntent.OperationID, journal.WithdrawIntent, transitionProof)
	if err != nil || exact != old {
		t.Fatal("original withdrawal intent not captured", exact, err)
	}
}

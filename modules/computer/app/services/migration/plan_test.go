package migration

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/journal"
)

func TestPlansBindRequestAndPhase(t *testing.T) {
	ctx := context.Background()
	owner, store, _ := makeOwner(true)
	if _, err := owner.Begin(ctx, intent()); err != nil {
		t.Fatal(err)
	}
	receipt := mustPlan(t, owner, journal.WithdrawIntent)
	if again := mustPlan(t, owner, journal.WithdrawIntent); again != receipt {
		t.Fatal("identical plan changed", again)
	}
	if other := mustPlan(t, owner, journal.SettingsIntent); other.EffectID == receipt.EffectID || other.Digest == receipt.Digest {
		t.Fatal("plan crossed phase", other)
	}
	original := store.journal.Entries[0].Request
	original.RequestDigest = receipt.Digest
	if changed := planReceipt(original, journal.WithdrawIntent); changed.Digest == receipt.Digest {
		t.Fatal("plan did not bind request digest")
	}
	if _, err := owner.Plan(ctx, "another", journal.WithdrawIntent); err != journal.ErrRefused {
		t.Fatal("plan crossed operation", err)
	}
	if store.journal.Entries[0].Phase != journal.Intent {
		t.Fatal("plan wrote to the journal")
	}
}

func TestSettingsPlanReadRequalifiesHeldChainsWithoutAnotherIntent(t *testing.T) {
	ctx := context.Background()
	o, store, native := makeOwner(true)
	if _, err := o.Begin(ctx, intent()); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Confirm(ctx, one, measuredFixture.Binding.Path, true); err != nil {
		t.Fatal(err)
	}
	withdraw := mustPlan(t, o, journal.WithdrawIntent)
	if err := o.Record(ctx, one, journal.WithdrawIntent, withdraw); err != nil {
		t.Fatal(err)
	}
	ack, err := o.WithdrawOnce(ctx, one, func(_ context.Context, _ string, planned journal.Receipt) (journal.Receipt, error) {
		return journal.Receipt{EffectID: planned.EffectID, Digest: goodDigest}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := o.Record(ctx, one, journal.WithdrawAcknowledged, ack); err != nil {
		t.Fatal(err)
	}
	settings := mustPlan(t, o, journal.SettingsIntent)
	if err := o.Record(ctx, one, journal.SettingsIntent, settings); err != nil {
		t.Fatal(err)
	}
	if got := mustPlan(t, o, journal.SettingsIntent); got != settings {
		t.Fatal("native recheck changed the original Settings plan")
	}
	native.allowed = false
	if _, err := o.Plan(ctx, one, journal.SettingsIntent); !errors.Is(err, journal.ErrUnknown) {
		t.Fatal("stale held chain supplied a Settings witness", err)
	}
	if store.journal.Entries[0].Phase != journal.SettingsIntent {
		t.Fatal("Settings witness read changed the journal")
	}
}

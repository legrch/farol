package migration

import (
	"context"
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

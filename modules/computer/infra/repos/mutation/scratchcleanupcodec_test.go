package mutation

import (
	"bytes"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestScratchCleanupCodecRetainsExactParentAndUnknown(t *testing.T) {
	creation := scratchCompleted(t, scratchPrepared(t))
	prepared, err := domain.NewScratchCleanup(creation)
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []domain.Phase{domain.Prepared, domain.Completed, domain.Failed, domain.OutcomeUnknown} {
		var f *domain.Failure
		if phase == domain.Failed {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
		}
		if phase == domain.OutcomeUnknown {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
		}
		original, err := domain.RestoreScratchCleanup(prepared.Binding(), phase, f)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := encodeScratchCleanup(original)
		if err != nil || !bytes.Contains(raw, []byte(`"schemaVersion":8`)) {
			t.Fatal("cleanup envelope", err)
		}
		got, err := decodeScratchCleanup(raw)
		if err != nil || got.Binding() != original.Binding() || got.Phase() != phase || (f == nil) != (got.Failure() == nil) {
			t.Fatal("cleanup facts lost", phase, err)
		}
		if f != nil && *got.Failure() != *f {
			t.Fatal("failure changed", phase)
		}
		if _, err := decodeScratchCleanup(append(bytes.Clone(raw), ' ')); err == nil {
			t.Fatal("noncanonical record accepted")
		}
		if _, err := decodeScratchCleanup(bytes.Replace(raw, []byte(`"expectedInventory":[]`), []byte(`"expectedInventory":["other"]`), 1)); err == nil {
			t.Fatal("foreign inventory accepted")
		}
	}
}

func TestScratchCleanupFreshInventoryRequiresOriginalParent(t *testing.T) {
	creation := scratchCompleted(t, scratchPrepared(t))
	cleanup, err := domain.NewScratchCleanup(creation)
	if err != nil {
		t.Fatal(err)
	}
	parentKey, _ := recordKey(creation.Binding().Identity)
	cleanupKey, _ := scratchCleanupKey(creation.Binding().Identity)
	parent, _ := encode(creation)
	selection := SettledSelection{OwnerID: creation.Binding().Identity.OwnerID, ProfileID: creation.Binding().Identity.ProfileID, ComputerID: creation.Binding().Identity.ComputerID}
	for _, phase := range []domain.Phase{domain.Prepared, domain.Completed, domain.Failed, domain.OutcomeUnknown} {
		var f *domain.Failure
		if phase == domain.Failed {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
		}
		if phase == domain.OutcomeUnknown {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
		}
		state, _ := domain.RestoreScratchCleanup(cleanup.Binding(), phase, f)
		raw, _ := encodeScratchCleanup(state)
		child := settledBytes{key: cleanupKey, raw: raw}
		entries := []settledBytes{{key: parentKey, raw: parent}, child}
		unknown, err := qualifyFreshProcessHistory(entries, selection)
		if err != nil || unknown {
			t.Fatal("fresh cleanup classification", phase, unknown, err)
		}
		reversed, err := qualifyFreshProcessHistory([]settledBytes{child, {key: parentKey, raw: parent}}, selection)
		if err != nil || reversed != unknown {
			t.Fatal("inventory order changed cleanup classification", phase, err)
		}
		eligible, err := qualifyStagingHistory(entries, selection)
		if err != nil || eligible != (phase == domain.Completed || phase == domain.Failed) {
			t.Fatal("staging cleanup classification", phase, eligible, err)
		}
		if _, err := qualifyFreshProcessHistory([]settledBytes{child}, selection); err == nil {
			t.Fatal("cleanup without original creation accepted", phase)
		}
		unfinished, _ := encode(scratchPrepared(t))
		if _, err := qualifyFreshProcessHistory([]settledBytes{{key: parentKey, raw: unfinished}, child}, selection); err == nil {
			t.Fatal("cleanup with unfinished original creation accepted", phase)
		}
		if _, err := qualifyFreshProcessHistory([]settledBytes{{key: parentKey, raw: parent}, child, child}, selection); err == nil {
			t.Fatal("duplicate cleanup key accepted", phase)
		}
		changed := cleanup.Binding()
		changed.Directory.Inode = "77"
		wrong, _ := domain.RestoreScratchCleanup(changed, phase, f)
		wrongRaw, _ := encodeScratchCleanup(wrong)
		if _, err := qualifyFreshProcessHistory([]settledBytes{{key: parentKey, raw: parent}, {key: cleanupKey, raw: wrongRaw}}, selection); err == nil {
			t.Fatal("cleanup with crossed native identity accepted", phase)
		}
	}
}

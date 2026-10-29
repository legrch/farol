package mutation

import (
	"bytes"
	"strings"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func fileCleanupFixture(t *testing.T) (*domain.State, *domain.State, *domain.ScratchFileInventory) {
	t.Helper()
	creation := scratchCompleted(t, scratchPrepared(t))
	_, _, base := connectorV3Fixture(t)
	b := base.Binding()
	b.RelativePath = creation.Binding().RelativePath + "/check.txt"
	prepared, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	file, err := prepared.Complete(domain.Receipt{Operation: domain.WriteKind, RelativePath: b.RelativePath, AfterSHA256: strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	inventory, err := domain.NewScratchFileInventory(creation, file, domain.DirectoryIdentity{Device: "7", Inode: "40"})
	if err != nil {
		t.Fatal(err)
	}
	return creation, file, inventory
}

func TestScratchFileCleanupCodecPreservesInventoryAndUnknown(t *testing.T) {
	_, _, inventory := fileCleanupFixture(t)
	for _, phase := range []domain.Phase{domain.Prepared, domain.Completed, domain.Failed, domain.OutcomeUnknown} {
		var f *domain.Failure
		if phase == domain.Failed {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
		}
		if phase == domain.OutcomeUnknown {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
		}
		original, err := domain.RestoreScratchFileCleanup(*inventory, phase, f)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := encodeScratchFileCleanup(original)
		if err != nil {
			t.Fatal(err)
		}
		got, err := decodeScratchFileCleanup(raw)
		if err != nil || got.Inventory() != *inventory || got.Phase() != phase || (f == nil) != (got.Failure() == nil) {
			t.Fatal("lost cleanup evidence", phase, err)
		}
		if f != nil && *got.Failure() != *f {
			t.Fatal("changed failure")
		}
		if _, err := decodeScratchFileCleanup(append(bytes.Clone(raw), ' ')); err == nil {
			t.Fatal("noncanonical accepted")
		}
		if _, err := decodeScratchFileCleanup(bytes.Replace(raw, []byte(`"sha256":"`+strings.Repeat("b", 64)+`"`), []byte(`"sha256":"bad"`), 1)); err == nil {
			t.Fatal("invalid hash accepted")
		}
	}
}

func TestScratchFileCleanupFreshRequiresBothOriginals(t *testing.T) {
	creation, file, inventory := fileCleanupFixture(t)
	creationKey, _ := recordKey(creation.Binding().Identity)
	fileKey, _ := recordKey(file.Binding().Identity)
	cleanupKey, _ := scratchCleanupKey(creation.Binding().Identity)
	creationRaw, _ := encode(creation)
	fileRaw, _ := encode(file)
	selection := SettledSelection{OwnerID: creation.Binding().Identity.OwnerID, ProfileID: creation.Binding().Identity.ProfileID, ComputerID: creation.Binding().Identity.ComputerID}
	for _, phase := range []domain.Phase{domain.Prepared, domain.Completed, domain.Failed, domain.OutcomeUnknown} {
		var f *domain.Failure
		if phase == domain.Failed {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
		}
		if phase == domain.OutcomeUnknown {
			f = &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
		}
		cleanup, err := domain.RestoreScratchFileCleanup(*inventory, phase, f)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := encodeScratchFileCleanup(cleanup)
		if err != nil {
			t.Fatal(err)
		}
		parent := settledBytes{key: creationKey, raw: creationRaw}
		fileEntry := settledBytes{key: fileKey, raw: fileRaw}
		child := settledBytes{key: cleanupKey, raw: raw}
		entries := []settledBytes{child, fileEntry, parent}
		if unknown, err := qualifyFreshProcessHistory(entries, selection); err != nil || unknown {
			t.Fatal("fresh refused history", phase, err)
		}
		eligible, err := qualifyStagingHistory(entries, selection)
		if err != nil || eligible != (phase == domain.Completed || phase == domain.Failed) {
			t.Fatal("wrong staging classification", phase, eligible, err)
		}
		for _, missing := range [][]settledBytes{{child, parent}, {child, fileEntry}} {
			if _, err := qualifyFreshProcessHistory(missing, selection); err == nil {
				t.Fatal("missing parent accepted", phase)
			}
		}
		changed := *inventory
		changed.SHA256 = strings.Repeat("c", 64)
		crossed, _ := domain.RestoreScratchFileCleanup(changed, phase, f)
		crossedRaw, _ := encodeScratchFileCleanup(crossed)
		if _, err := qualifyFreshProcessHistory([]settledBytes{parent, fileEntry, {key: cleanupKey, raw: crossedRaw}}, selection); err == nil {
			t.Fatal("crossed receipt accepted", phase)
		}
	}
}

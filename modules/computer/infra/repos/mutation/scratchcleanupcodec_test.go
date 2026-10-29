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

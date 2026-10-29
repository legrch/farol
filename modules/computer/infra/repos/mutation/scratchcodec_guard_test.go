package mutation

import (
	"bytes"
	"context"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Scratch is never projected into the older envelopes; every phase roundtrips
// its original binding and uncertain directory evidence.
func TestScratchNeverUsesLegacyCodecOrFreshKey(t *testing.T) {
	r, disk, original := ownerFixture(t)
	b := original.Binding()
	b.Identity.OperationID = "00000000-0000-4000-8000-000000000001"
	b.RelativePath = domain.ScratchPath(b.Identity.OperationID)
	b.Scratch = domain.ScratchBinding{RunID: b.Identity.OperationID, Root: "/workspace", Leaf: b.RelativePath, RootIdentity: domain.DirectoryIdentity{Device: "1", Inode: "2"}, ExpectedInventory: domain.EmptyScratchInventory}
	prepared, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	dir := domain.DirectoryIdentity{Device: "1", Inode: "42"}
	completed, err := prepared.Complete(domain.Receipt{Operation: domain.ScratchKind, RelativePath: b.RelativePath, Directory: dir})
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace", Directory: dir})
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []*domain.State{prepared, completed, unknown} {
		raw, err := encode(state)
		if err != nil || !bytes.Contains(raw, []byte(`"schemaVersion":7`)) {
			t.Fatal("scratch encoded in legacy envelope", err)
		}
		decoded, err := decode(raw)
		if err != nil || decoded.Binding() != b || decoded.Phase() != state.Phase() {
			t.Fatal("scratch facts lost", err)
		}
	}
	if admission, err := r.Admit(context.Background(), prepared); err != nil || admission.Record == nil || disk.creates != 1 {
		t.Fatal("scratch admission unavailable", err)
	}
	if admission, err := r.Admit(context.Background(), prepared); err != nil || admission.Record == nil || disk.creates != 1 {
		t.Fatal("same operation was admitted twice", err)
	}
}

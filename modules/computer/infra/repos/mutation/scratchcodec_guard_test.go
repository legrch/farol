package mutation

import (
	"context"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Until a dedicated codec is connected, never discard the original scratch
// binding or its unknown directory evidence into a legacy envelope.
func TestLegacyCodecRefusesScratchWithoutPublishing(t *testing.T) {
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
		if raw, err := encode(state); err == nil || raw != nil {
			t.Fatal("legacy codec dropped scratch facts")
		}
	}
	if _, err := r.Admit(context.Background(), prepared); err == nil || disk.creates != 0 || len(disk.files) != 0 {
		t.Fatal("unencodable scratch was published", err)
	}
}

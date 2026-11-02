//go:build darwin

package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// Disposable physical filesystem only: no live profile, journal or MCP.
func TestNativeRemoveOneFilePreservesNeighbor(t *testing.T) {
	d := fixture(t)
	put(t, d, "owned.md", []byte("owned"))
	put(t, d, "neighbor.md", []byte("keep"))
	op := mutation.Remove{RelativePath: "owned.md", ExpectedSHA256: payloadHash([]byte("owned"))}
	request := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: d.WorkspaceID, Root: d.Root, ApprovedRoot: d.ApprovedRoot}, Operation: op, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
	out, err := NewMutable(d.Root+"-home").Mutate(context.Background(), request)
	if err != nil || out == nil || out.BeforeSHA256 == nil || *out.BeforeSHA256 != op.ExpectedSHA256 || out.AfterSHA256 != "" {
		t.Fatalf("bad removal: %+v %v", out, err)
	}
	if _, err := os.Lstat(filepath.Join(d.Root, "owned.md")); !os.IsNotExist(err) {
		t.Fatalf("target remains: %v", err)
	}
	neighbor, err := os.ReadFile(filepath.Join(d.Root, "neighbor.md"))
	if err != nil || string(neighbor) != "keep" {
		t.Fatal("neighbor changed")
	}
}

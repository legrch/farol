//go:build !darwin

package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// Native mutation is unavailable on this OS. These calls exercise the public
// producer boundary and prove unsupported requests have no filesystem effect.
func TestMutationUnsupportedNativeRefusesWithoutPublication(t *testing.T) {
	if nativeMutationFS() != nil {
		t.Fatal("native mutation is expected to be unavailable on this OS")
	}

	for _, tc := range []struct {
		name string
		op   mutation.Operation
	}{
		{name: "create", op: mutation.Write{RelativePath: "created.md", Content: "new"}},
		{name: "replace", op: mutation.Write{RelativePath: "existing.md", Content: "new", ExpectedSHA256: func() *string { hash := payloadHash([]byte("seed\n")); return &hash }()}},
		{name: "edit", op: mutation.Edit{RelativePath: "existing.md", ExpectedSHA256: payloadHash([]byte("seed\n")), Edits: []mutation.TextEdit{{OldText: "seed", NewText: "changed"}}}},
		{name: "nested parents", op: mutation.Write{RelativePath: "nested/deeper/created.md", Content: "new"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := fixture(t)
			seed := []byte("seed\n")
			if tc.name == "replace" || tc.name == "edit" {
				put(t, d, "existing.md", seed)
			}

			beforePublishCalls, publicationCalls := 0, 0
			req := port.MutationRequest{
				Workspace: port.MutationDescriptor{
					WorkspaceID:  d.WorkspaceID,
					Root:         d.Root,
					ApprovedRoot: d.ApprovedRoot,
					DeniedPaths:  d.DeniedPaths,
				},
				Operation: tc.op,
				BeforePublish: func(context.Context) error {
					beforePublishCalls++
					return nil
				},
				WithPublication: func(_ context.Context, publish func() error) error {
					publicationCalls++
					return publish()
				},
			}
			receipt, err := NewMutable(d.Root+"-home").Mutate(context.Background(), req)
			if receipt != nil {
				t.Fatal("unsupported mutation returned a receipt", receipt)
			}
			expectCode(t, err, "WORKSPACE_PATH_REFUSED")
			if beforePublishCalls != 0 || publicationCalls != 0 {
				t.Fatalf("unsupported mutation entered publication callbacks: before=%d publication=%d", beforePublishCalls, publicationCalls)
			}

			if tc.name == "replace" || tc.name == "edit" {
				got, readErr := os.ReadFile(filepath.Join(d.Root, "existing.md"))
				if readErr != nil || string(got) != string(seed) {
					t.Fatalf("seeded file changed: got %q, err %v", got, readErr)
				}
			}
			for _, target := range []string{"created.md", "nested/deeper/created.md"} {
				if _, statErr := os.Lstat(filepath.Join(d.Root, target)); !os.IsNotExist(statErr) {
					t.Fatalf("create target %q exists after refusal: %v", target, statErr)
				}
			}
			for _, parent := range []string{"nested", "nested/deeper"} {
				if _, statErr := os.Lstat(filepath.Join(d.Root, parent)); !os.IsNotExist(statErr) {
					t.Fatalf("nested parent %q exists after refusal: %v", parent, statErr)
				}
			}
		})
	}
}

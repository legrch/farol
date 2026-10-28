//go:build darwin

package boot

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// This verifies the actual file producers on a disposable filesystem. Shell
// confinement and profile-descriptor lifetime are separate requirements.
func TestNativeComputerStateMutationProtection(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	image, state := filepath.Join(base, "image"), filepath.Join(base, "computer")
	for _, dir := range []string{image, state, filepath.Join(base, "home")} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	owners, err := newComputerFileOwnersWithImage(filepath.Join(base, "home"), imageFixtureRoot(t, image), imageFixtureRoot(t, state))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(state, filepath.Join(base, "moved-state")); err != nil {
		t.Fatal(err)
	}
	state = filepath.Join(base, "moved-state")
	if err := os.Symlink(state, filepath.Join(base, "alias")); err != nil {
		t.Fatal(err)
	}
	for _, policy := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		for _, path := range []string{"moved-state/new.txt", "moved-state/sub/new.txt", "alias/new.txt"} {
			calls := 0
			r := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: policy, WorkspaceID: "fixture", Root: base, ApprovedRoot: imageFixtureRoot(t, base)}, Operation: mutation.Write{RelativePath: path, Content: "fixture"}, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { calls++; return publish() }}
			if receipt, err := owners.Mutate(context.Background(), r); receipt != nil || err == nil || calls != 0 {
				t.Fatalf("state mutation admitted: %s %s", policy, path)
			}
		}
		r := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: policy, WorkspaceID: "fixture", Root: base, ApprovedRoot: imageFixtureRoot(t, base)}, Operation: mutation.Write{RelativePath: "ordinary-" + string(policy) + ".txt", Content: "fixture"}, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
		if receipt, err := owners.Mutate(context.Background(), r); err != nil || receipt == nil {
			t.Fatalf("sibling refused: %v", err)
		}
	}
}

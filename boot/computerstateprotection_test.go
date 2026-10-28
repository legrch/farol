//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
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
	payload := []byte("original")
	for _, dir := range []string{image, state} {
		if err := os.WriteFile(filepath.Join(dir, "sentinel.txt"), payload, 0600); err != nil {
			t.Fatal(err)
		}
	}
	digest := sha256.Sum256(payload)
	hash := hex.EncodeToString(digest[:])
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
			if receipt, err := owners.Mutate(context.Background(), r); receipt != nil || err == nil || !strings.Contains(err.Error(), "WORKSPACE_PATH_REFUSED") || calls != 0 {
				t.Fatalf("state mutation admitted: %s %s", policy, path)
			}
		}
		for _, selected := range []struct{ root, path string }{
			{base, "moved-state/sentinel.txt"}, {state, "sentinel.txt"}, {base, "image/sentinel.txt"},
		} {
			for _, op := range []mutation.Operation{
				mutation.Write{RelativePath: selected.path, Content: "replacement", ExpectedSHA256: &hash},
				mutation.Edit{RelativePath: selected.path, ExpectedSHA256: hash, Edits: []mutation.TextEdit{{OldText: "original", NewText: "changed"}}},
			} {
				calls := 0
				r := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: policy, WorkspaceID: "fixture", Root: selected.root, ApprovedRoot: imageFixtureRoot(t, selected.root)}, Operation: op, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { calls++; return publish() }}
				receipt, err := owners.Mutate(context.Background(), r)
				if receipt != nil || err == nil || !strings.Contains(err.Error(), "WORKSPACE_PATH_REFUSED") || calls != 0 {
					t.Fatalf("protected overwrite %s/%s: receipt=%v error=%v publications=%d", selected.root, selected.path, receipt, err, calls)
				}
			}
		}
		for _, dir := range []string{state, image} {
			if got, err := os.ReadFile(filepath.Join(dir, "sentinel.txt")); err != nil || string(got) != string(payload) {
				t.Fatalf("protected bytes changed: %s: %v", dir, err)
			}
		}
		r := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: policy, WorkspaceID: "fixture", Root: base, ApprovedRoot: imageFixtureRoot(t, base)}, Operation: mutation.Write{RelativePath: "ordinary-" + string(policy) + ".txt", Content: "fixture"}, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
		if receipt, err := owners.Mutate(context.Background(), r); err != nil || receipt == nil {
			t.Fatalf("sibling refused: %v", err)
		}
	}
}

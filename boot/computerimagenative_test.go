//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func imageFixtureRoot(t *testing.T, path string) port.Root {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	v := info.Sys().(*syscall.Stat_t)
	return port.Root{Path: path, Device: strconv.FormatUint(uint64(v.Dev), 10), Inode: strconv.FormatUint(uint64(v.Ino), 10)}
}

// Native disposable filesystem and actual shared File producers. Publication
// callbacks are lease doubles; no Shell capability or Commands grant exists.
func TestNativeComputerFileImageProtectionIndependentOfCommands(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(base, "dev-core")
	for _, dir := range []string{image, filepath.Join(base, "home")} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	payload := []byte("original image\n")
	target := filepath.Join(image, "preload.cjs")
	if err := os.WriteFile(target, payload, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(image, filepath.Join(base, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(target, filepath.Join(base, "hardlink.cjs")); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	hash := hex.EncodeToString(digest[:])
	owners, err := newComputerFileOwnersWithImage(filepath.Join(base, "home"), imageFixtureRoot(t, image))
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		t.Run(string(policy), func(t *testing.T) {
			for _, selected := range []struct{ root, path string }{
				{base, "dev-core/preload.cjs"}, {image, "preload.cjs"},
				{base, "alias/preload.cjs"}, {base, "hardlink.cjs"},
				{base, "dev-core/new/created.txt"},
			} {
				for _, op := range []mutation.Operation{
					mutation.Write{RelativePath: selected.path, Content: "replacement", ExpectedSHA256: &hash},
					mutation.Edit{RelativePath: selected.path, ExpectedSHA256: hash, Edits: []mutation.TextEdit{{OldText: "original", NewText: "changed"}}},
				} {
					publications := 0
					request := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: policy, WorkspaceID: "fixture", Root: selected.root, ApprovedRoot: imageFixtureRoot(t, selected.root)}, Operation: op,
						BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { publications++; return publish() }}
					receipt, err := owners.Mutate(context.Background(), request)
					if receipt != nil || err == nil || !strings.Contains(err.Error(), "WORKSPACE_PATH_REFUSED") || publications != 0 {
						t.Fatalf("protected route %s/%s: receipt=%v error=%v publications=%d", selected.root, selected.path, receipt, err, publications)
					}
				}
			}
			if actual, err := os.ReadFile(target); err != nil || string(actual) != string(payload) {
				t.Fatal("protected image changed", err)
			}
			request := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: policy, WorkspaceID: "fixture", Root: base, ApprovedRoot: imageFixtureRoot(t, base)}, Operation: mutation.Write{RelativePath: "ordinary-" + string(policy) + ".txt", Content: "allowed"}, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
			receipt, err := owners.Mutate(context.Background(), request)
			if err != nil || receipt == nil {
				t.Fatal("ordinary sibling refused", err)
			}
		})
	}
	// A moved protected object remains protected by identity at its new path.
	moved := filepath.Join(base, "moved-image")
	if err := os.Rename(image, moved); err != nil {
		t.Fatal(err)
	}
	request := port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: authority.RootScopedFiles, WorkspaceID: "fixture", Root: base, ApprovedRoot: imageFixtureRoot(t, base)}, Operation: mutation.Write{RelativePath: "moved-image/preload.cjs", Content: "replacement", ExpectedSHA256: &hash}, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
	if _, err := owners.Mutate(context.Background(), request); err == nil || !strings.Contains(err.Error(), "WORKSPACE_PATH_REFUSED") {
		t.Fatal("moved image lost protection", err)
	}
}

func TestComputerImageRootBindsKernelExecutable(t *testing.T) {
	root, err := currentComputerImageRoot()
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	expected := imageFixtureRoot(t, filepath.Dir(executable))
	if root != expected {
		t.Fatalf("image root not bound to actual executable: %+v", root)
	}
}

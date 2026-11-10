//go:build darwin

package observation

import (
	"context"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
	"os"
	"path/filepath"
	"testing"
)

// This witness only measures disposable native state. It never remounts, starts
// Farol, reads an approved workspace, or changes a grant. A remount/reboot is a
// separate NOT RUN witness; assigning a different Device below cannot prove it.
func TestDarwinDisposableAPFSObservation(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(base, "workspace")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	first, err := New().Observe(context.Background(), path)
	if err != nil {
		t.Fatalf("native qualification requires supported local APFS: %v", err)
	}
	second, err := New().Observe(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	saved := identity.Saved{Binding: first.Binding, Evidence: &first.Evidence}
	if identity.Compare(saved, second, identity.Settled) != identity.SameMountCandidate {
		t.Fatal("repeat observation differs")
	}
	if err := os.Rename(path, path+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	replacement, err := New().Observe(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Compare(saved, replacement, identity.Settled) != identity.DifferentDirectory {
		t.Fatal("replacement folder accepted")
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := New().Observe(context.Background(), link); code(err) != "WORKSPACE_PATH_REFUSED" {
		t.Fatalf("symlink accepted: %v", err)
	}
}

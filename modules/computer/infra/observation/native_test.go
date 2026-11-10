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

// Native disposable witness: original target fd must survive until Close, while
// requalification rejects the replacement at the original approved name.
// Does not imply remount, restart, settings enrollment, or publication safety.
func TestDarwinDisposableHeldCandidateRequalification(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(base, "candidate")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	h, err := NewHolder().Hold(context.Background(), workspace)
	if err != nil {
		t.Fatalf("local APFS required: %v", err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	observed, err := h.Snapshot()
	if err != nil || !observed.Valid() || observed.Binding.Path != workspace {
		t.Fatalf("%+v %v", observed, err)
	}
	if err := h.Requalify(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "content"), []byte("churn"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := h.Requalify(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(workspace, workspace+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if code(h.Requalify(context.Background())) != "WORKSPACE_RACE_DETECTED" {
		t.Fatal("replacement accepted")
	}
	if _, err := h.Snapshot(); code(err) != "WORKSPACE_RACE_DETECTED" {
		t.Fatal("stale snapshot was accepted")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(workspace, link); err != nil {
		t.Fatal(err)
	}
	if got, err := NewHolder().Hold(context.Background(), link); got != nil || code(err) != "WORKSPACE_PATH_REFUSED" {
		t.Fatalf("symlink %v %v", got, err)
	}
}

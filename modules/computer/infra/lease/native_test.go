//go:build darwin

package lease

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Native witness to run only on a disposable directory of the qualified startup
// Data filesystem. It never mounts volumes or alters a Farol workspace/profile.
// A passing result is NOT a reboot/remount or production authority test.
func TestDarwinDisposableStartupDataAnchor(t *testing.T) {
	a, err := New().Acquire(context.Background())
	if err != nil {
		t.Fatalf("startup Data eligibility unavailable: %v", err)
	}
	defer func() {
		if e := a.Close(); e != nil {
			t.Fatal(e)
		}
	}()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(path, "candidate")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	got, err := a.Check(context.Background(), target)
	if err != nil || got.Authority != "not-established" {
		t.Fatalf("current Data candidate: %+v %v", got, err)
	}
	link := filepath.Join(path, "symlink")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Check(context.Background(), link); anchorCode(err) != "WORKSPACE_ANCHOR_PATH_REFUSED" {
		t.Fatalf("followed symlink: %v", err)
	}
	if err := a.Requalify(context.Background()); err != nil {
		t.Fatal(err)
	}
}

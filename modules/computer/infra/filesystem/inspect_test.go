package filesystem

import (
	"context"
	"github.com/legrch/farol/modules/computer/app/port"
	"os"
	"path/filepath"
	"testing"
)

// Disposable native directories: this is filesystem evidence, not a provider test.
func TestInspectAcceptsChangingChildrenWithoutListingThem(t *testing.T) {
	d := fixture(t)
	w := New(d.Root + "-home")
	w.afterRead = func() { put(t, d, "new-child", []byte("changed during inspection")) }
	result, err := w.Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil || result == nil || result.ApprovedRoot != d.ApprovedRoot || result.RelativePath != "." {
		t.Fatalf("inspection: %+v %v", result, err)
	}
}

func TestInspectRejectsDirectoryReplacement(t *testing.T) {
	for _, relative := range []string{".", "child"} {
		t.Run(relative, func(t *testing.T) {
			d := fixture(t)
			target := d.Root
			if relative != "." {
				target = filepath.Join(d.Root, relative)
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			w := New(d.Root + "-home")
			w.afterRead = func() {
				if err := os.Rename(target, target+"-previous"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.RemoveAll(target + "-previous") })
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			out, err := w.Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: relative})
			if out != nil {
				t.Fatalf("replaced directory disclosed: %+v", out)
			}
			expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
		})
	}
}

func TestInspectRejectsSymlinkDeniedPathAndCancellation(t *testing.T) {
	d := fixture(t)
	if err := os.Mkdir(filepath.Join(d.Root, "child"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("child", filepath.Join(d.Root, "link")); err != nil {
		t.Fatal(err)
	}
	for _, relative := range []string{"link", "../outside", "child"} {
		selected := d
		selected.DeniedPaths = []string{"child"}
		out, err := New(d.Root+"-home").Inspect(context.Background(), port.ListRequest{Workspace: selected, RelativePath: relative})
		if err == nil || out != nil {
			t.Fatalf("unsafe inspection accepted %s: %+v %v", relative, out, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := New(d.Root+"-home").Inspect(ctx, port.ListRequest{Workspace: d, RelativePath: "."})
	if out != nil {
		t.Fatal("cancelled inspection disclosed")
	}
	expectCode(t, err, "WORKSPACE_REQUEST_CANCELLED")
}

func TestInspectRejectsAccessBoundaryChange(t *testing.T) {
	d := fixture(t)
	w := New(d.Root + "-home")
	w.afterRead = func() {
		if err := os.Chmod(d.Root, 0500); err != nil {
			t.Fatal(err)
		}
	}
	out, err := w.Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if out != nil {
		t.Fatal("changed access disclosed")
	}
	expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
}

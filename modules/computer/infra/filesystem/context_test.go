package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
)

// Real disposable native list evidence for the context operation's root proof.
func TestContextBindingComesFromCheckedRootAndSelectedDirectory(t *testing.T) {
	d := fixture(t)
	if err := os.MkdirAll(filepath.Join(d.Root, "scope", "selected"), 0700); err != nil {
		t.Fatal(err)
	}
	approved := d.ApprovedRoot
	d.Root = filepath.Join(d.Root, "scope")
	out, err := New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "selected"})
	if err != nil || out == nil || out.Binding == nil {
		t.Fatalf("binding: %v", err)
	}
	if out.Binding.RelativePath != "selected" || out.Binding.Root != d.Root || out.Binding.ApprovedRoot != approved || len(out.Entries) != 0 {
		t.Fatalf("lost opened ancestor/narrowed root: %#v", out)
	}
	_, err = New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "missing"})
	expectCode(t, err, "WORKSPACE_NOT_FOUND")
	if err := os.Symlink("selected", filepath.Join(d.Root, "alias")); err != nil {
		t.Fatal(err)
	}
	out, err = New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "alias"})
	if out != nil {
		t.Fatal("symlink returned root proof")
	}
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
}

func TestContextBindingIsDiscardedForNativeRacesAndReplacement(t *testing.T) {
	for _, test := range []struct {
		name, code, relative string
		replacement          bool
	}{
		{"directory change", "WORKSPACE_RACE_DETECTED", ".", false},
		{"selected root renamed", "WORKSPACE_RACE_DETECTED", ".", true},
		{"ancestor replaced", "WORKSPACE_ROOT_CHANGED", "selected", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			d := fixture(t)
			if test.relative != "." {
				if err := os.Mkdir(filepath.Join(d.Root, test.relative), 0700); err != nil {
					t.Fatal(err)
				}
			}
			w := New(d.Root + "-home")
			w.afterRead = func() {
				if test.replacement {
					if err := os.Rename(d.Root, d.Root+"-old"); err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { os.RemoveAll(d.Root + "-old") })
					if err := os.Mkdir(d.Root, 0700); err != nil {
						t.Fatal(err)
					}
				} else {
					put(t, d, "new.md", []byte("change"))
				}
			}
			out, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: test.relative})
			if out != nil {
				t.Fatal("stale native root proof disclosed")
			}
			expectCode(t, err, test.code)
		})
	}
}

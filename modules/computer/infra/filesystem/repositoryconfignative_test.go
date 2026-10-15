//go:build darwin

package filesystem

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestRepositoryConfigNativeOrdinaryReadCreateEdit(t *testing.T) {
	d, home, repo := repositoryConfigNativeFixture(t)
	d.Root = repo // Keep the independently measured approved ancestor.
	w, m := New(home), NewMutable(home)
	for _, path := range []string{".npmrc", "nested/.NPMRC"} {
		before := "repository-marker=before\n"
		receipt, err := m.Mutate(context.Background(), repositoryConfigNativeMutation(d, mutation.Write{RelativePath: path, Content: before}))
		if err != nil || receipt == nil {
			t.Fatal("repository config creation refused", err)
		}
		read, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: path})
		if err != nil || read.Text != before {
			t.Fatal("repository read failed", err)
		}
		listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: filepath.Dir(path)})
		if err != nil || !slices.Contains(listed.Entries, filepath.Base(path)) {
			t.Fatal("repository config not listed", err)
		}
		searched, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: path, Pattern: "repository-marker"})
		if err != nil || len(searched.Matches) != 1 || searched.Matches[0].Path != path {
			t.Fatal("repository config not searched", err)
		}
		receipt, err = m.Mutate(context.Background(), repositoryConfigNativeMutation(d, mutation.Edit{RelativePath: path, ExpectedSHA256: read.SHA256, Edits: []mutation.TextEdit{{OldText: "before", NewText: "after"}}}))
		if err != nil || receipt == nil {
			t.Fatal("repository config edit refused", err)
		}
		read, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: path})
		if err != nil || read.Text != "repository-marker=after\n" {
			t.Fatal("repository config edit not retained", err)
		}
	}
}

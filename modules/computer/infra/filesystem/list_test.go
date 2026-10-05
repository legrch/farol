package filesystem

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
)

func TestMarkdownIsListedAndReadableAcrossRepeatedRequests(t *testing.T) {
	d := fixture(t)
	put(t, d, "README.md", []byte("# Known Markdown"))
	put(t, d, "TODAY.md", []byte("# Today"))
	put(t, d, "plain.txt", []byte("text"))
	w := New(d.Root + "-home")
	for generation := 0; generation < 100; generation++ {
		listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
		if err != nil {
			t.Fatalf("generation %d: %v", generation, err)
		}
		if !reflect.DeepEqual(listed.Entries, []string{"plain.txt", "README.md", "TODAY.md"}) || listed.Truncated {
			t.Fatalf("generation %d omission: %+v", generation, listed)
		}
		for _, path := range []string{"README.md", "TODAY.md"} {
			if _, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: path}); err != nil {
				t.Fatalf("generation %d: %v", generation, err)
			}
		}
	}
}
func TestListOmitsDeniedLinksAndUnsupportedTypes(t *testing.T) {
	d := fixture(t)
	put(t, d, "visible.md", []byte("note"))
	put(t, d, "private.md", []byte("hidden"))
	put(t, d, "multiply.md", []byte("hard"))
	d.DeniedPaths = []string{"private.md"}
	if err := os.Link(filepath.Join(d.Root, "multiply.md"), filepath.Join(d.Root, "second.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("visible.md", filepath.Join(d.Root, "link.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(d.Root, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	out, err := New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Entries, []string{"folder/", "visible.md"}) {
		t.Fatalf("bad filtered list %+v", out)
	}
}
func TestListHonorsCaseAndNormalizationDenials(t *testing.T) {
	for _, test := range []struct{ name, deny string }{{".SSH", ".ssh"}, {"Café", "Café"}, {"STRASSE", "Straße"}} {
		t.Run(test.name, func(t *testing.T) {
			d := fixture(t)
			put(t, d, test.name, []byte("hidden"))
			d.DeniedPaths = []string{test.deny}
			out, err := New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
			if err != nil {
				t.Fatal(err)
			}
			if len(out.Entries) != 0 {
				t.Fatal("denial alias disclosed")
			}
			_, err = New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: test.name})
			expectCode(t, err, "WORKSPACE_PATH_REFUSED")
		})
	}
}
func TestListBoundsAndDetectsDirectoryChange(t *testing.T) {
	d := fixture(t)
	for i := 0; i < 501; i++ {
		put(t, d, fmt.Sprintf("file-%03d.md", i), []byte("note"))
	}
	out, err := New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil {
		t.Fatal(err)
	}
	if !out.Truncated || len(out.Entries) != 500 {
		t.Fatalf("not bounded %+v", out)
	}
	w := New(d.Root + "-home")
	w.afterRead = func() { put(t, d, "new.md", []byte("new")) }
	out, err = w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if out != nil {
		t.Fatal("mixed listing disclosed")
	}
	expectCode(t, err, "WORKSPACE_RACE_DETECTED")
	d.ExactFilePaths = []string{"file-000.md"}
	_, err = New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
}

func TestListUsesCasefoldSortWithoutDenialAccentFolding(t *testing.T) {
	d := fixture(t)
	put(t, d, "Á.md", []byte("note"))
	put(t, d, "B.md", []byte("note"))
	out, err := New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out.Entries, []string{"B.md", "Á.md"}) {
		t.Fatalf("changed list ordering %+v", out)
	}
}
func TestMandatorySecretsStayHiddenWithoutOwnerExclusions(t *testing.T) {
	d := fixture(t)
	put(t, d, ".env", []byte("synthetic"))
	put(t, d, "visible.md", []byte("visible"))
	if err := os.Mkdir(filepath.Join(d.Root, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, d, ".ssh/key", []byte("synthetic"))
	w := New(d.Root + "-home")
	listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(listed.Entries, []string{"visible.md"}) {
		t.Fatal("mandatory secret names disclosed")
	}
	for _, name := range []string{".env", ".ssh/key", ".SSH/key"} {
		_, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: name})
		expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	}
}
func TestHomeStoresCannotBeChosenAsRootsOrReachedThroughEnclosingRoots(t *testing.T) {
	d := fixture(t)
	home := filepath.Join(d.Root, "home")
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, d, "home/.ssh/key", []byte("synthetic"))
	w := New(home)
	_, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "home/.ssh/key"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	d.Root = filepath.Join(home, ".ssh")
	_, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "key"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
}
func TestMandatoryAndOwnerPolicyBoundFailsWithoutDroppingExclusions(t *testing.T) {
	d := fixture(t)
	// Twelve mandatory paths plus 53 distinct owner paths exceed the cap.
	for i := 0; i < 53; i++ {
		d.DeniedPaths = append(d.DeniedPaths, fmt.Sprintf("private-%d", i))
	}
	_, err := New(d.Root+"-home").List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	expectCode(t, err, "WORKSPACE_POLICY_TOO_LARGE")
}

type overflowNames struct{ remaining int }

func (r *overflowNames) Readdirnames(count int) ([]string, error) {
	if r.remaining == 0 {
		return nil, io.EOF
	}
	if count > r.remaining {
		count = r.remaining
	}
	r.remaining -= count
	out := make([]string, count)
	for i := range out {
		out[i] = fmt.Sprintf("file-%d.md", r.remaining+i)
	}
	return out, nil
}
func TestOverflowNeverClaimsAnArbitrarySortedSubset(t *testing.T) {
	names, truncated, err := boundedNames(context.Background(), &overflowNames{remaining: 100001})
	if err != nil || !truncated || len(names) != 0 {
		t.Fatalf("partial listing disclosed %d %t %v", len(names), truncated, err)
	}
	names, truncated, err = boundedNames(context.Background(), &overflowNames{remaining: 100000})
	if err != nil || truncated || len(names) != 100000 {
		t.Fatalf("exact bound lost %d %t %v", len(names), truncated, err)
	}
}

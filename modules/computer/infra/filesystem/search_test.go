package filesystem

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
)

// TestSearchPure* never opens a workspace, touches native storage or spawns a
// helper. TestSearchNative* uses disposable real filesystem state and MUST be
// selected separately once the exclusive native lane has been released.
func pureSearch(t *testing.T, pattern string) *searchScan {
	t.Helper()
	expression, err := searchExpression(pattern)
	if err != nil {
		t.Fatal(err)
	}
	return &searchScan{ctx: context.Background(), deadline: time.Now().Add(time.Minute), expression: expression, result: &port.SearchResponse{Matches: []port.SearchMatch{}}}
}
func TestSearchPureLinesUTF8AndExcerpt(t *testing.T) {
	s := pureSearch(t, "hit")
	text := "first\r\nhit\v🌊\u2028same\r\n" + strings.Repeat("🌊", 700) + "hit" + strings.Repeat("Ж", 50) + "\n"
	if err := s.lines("Note with spaces 🌊.md", text); err != nil {
		t.Fatal(err)
	}
	if len(s.result.Matches) != 2 || s.result.Matches[0].Line != 2 || s.result.Matches[0].Text != "hit�🌊\u2028same" || s.result.Matches[0].Truncated || s.result.Matches[1].Line != 3 || !s.result.Matches[1].Truncated || len([]rune(s.result.Matches[1].Text)) != 500 || !strings.Contains(s.result.Matches[1].Text, "hit") {
		t.Fatalf("line/excerpt %+v", s.result)
	}
	s = pureSearch(t, "^")
	if err := s.lines("empty.md", ""); err != nil || len(s.result.Matches) != 0 {
		t.Fatal("empty input had a line")
	}
	if err := s.lines("lines.md", "\n\n"); err != nil || len(s.result.Matches) != 2 {
		t.Fatal("phantom final LF hit or lost empty lines")
	}
	s = pureSearch(t, "hit")
	s.lines("long.md", strings.Repeat("a", 600)+"hit"+strings.Repeat("b", 100))
	if !strings.Contains(s.result.Matches[0].Text, "hit") {
		t.Fatal("long line hid match")
	}
}
func TestSearchPureLimitsAreIndependent(t *testing.T) {
	for _, n := range []int{100, 101} {
		s := pureSearch(t, "hit")
		s.lines("note.md", strings.Repeat("hit\n", n))
		if len(s.result.Matches) != 100 || s.result.ResultLimited != (n > 100) || s.result.ScanLimited {
			t.Fatalf("result limit n=%d %+v", n, s.result)
		}
	}
	s := pureSearch(t, "hit")
	s.output = searchOutputBytes - 1
	s.lines("note.md", "hit")
	if !s.result.ResultLimited || s.result.ScanLimited || len(s.result.Matches) != 0 {
		t.Fatal("lost serialized-byte ceiling")
	}
	s = pureSearch(t, "hit")
	s.deadline = time.Now().Add(-time.Second)
	expectCode(t, s.lines("note.md", "hit"), "WORKSPACE_SEARCH_TIMEOUT")
	if len(s.result.Matches) != 0 {
		t.Fatal("deadline became absence")
	}
	s = pureSearch(t, "hit")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.ctx = ctx
	expectCode(t, s.lines("note.md", "hit"), "WORKSPACE_REQUEST_CANCELLED")
	match := port.SearchMatch{Path: "🌊.md", Line: 1, Text: "🌊"}
	ascii := searchMatchBytes(match)
	match.Path = "a.md"
	match.Text = "a"
	if ascii-searchMatchBytes(match) != 22 {
		t.Fatal("astral JSON response charge was not ASCII escaped")
	}
}

type searchPureNames struct{ names []string }

func (n *searchPureNames) Readdirnames(count int) ([]string, error) {
	if len(n.names) == 0 {
		return nil, io.EOF
	}
	take := min(count, len(n.names))
	out := n.names[:take]
	n.names = n.names[take:]
	return out, nil
}
func TestSearchPureGlobalEntryBudget(t *testing.T) {
	s := pureSearch(t, "hit")
	s.entries = searchEntries - 2
	names, limited, err := s.names(&searchPureNames{names: []string{"b", "a"}})
	if err != nil || limited || len(names) != 2 || s.entries != searchEntries {
		t.Fatal("exact entry bound")
	}
	s = pureSearch(t, "hit")
	s.entries = searchEntries - 2
	names, limited, err = s.names(&searchPureNames{names: []string{"a", "b", "c"}})
	if err != nil || !limited || len(names) != 0 || s.entries != searchEntries {
		t.Fatal("overflow disclosed arbitrary subset")
	}
}
func TestSearchPureRegexAndIgnoreRules(t *testing.T) {
	for _, pattern := range []string{"Markdown", "^# (Known|Today)", "(?i)note", `[Ж🌊]+`, "a.*b"} {
		if _, err := searchExpression(pattern); err != nil {
			t.Fatalf("valid expression %q: %v", pattern, err)
		}
	}
	for _, pattern := range []string{"", "[", `(?=secret)`, `(a)\1`, `\w+`, `\bnote\b`, `(a+)+`, `a+b+`, `(ab|cd)+`, `(?U)a+`, `\x{41}`, string([]byte{255}), strings.Repeat("🌊", 2049)} {
		_, err := searchExpression(pattern)
		expectCode(t, err, "WORKSPACE_INVALID_REQUEST")
	}
	var rules []searchIgnoreRule
	for _, pattern := range []string{"*.md", "!README.md", "hidden/", "/root.txt", "**/cache?.txt"} {
		r, ok := searchIgnore("", pattern)
		if !ok {
			t.Fatalf("invalid ignore %q", pattern)
		}
		rules = append(rules, r)
	}
	for _, test := range []struct {
		path      string
		dir, want bool
	}{{"note.md", false, true}, {"README.md", false, false}, {"nested/README.md", false, false}, {"hidden", true, true}, {"hidden", false, false}, {"root.txt", false, true}, {"nested/root.txt", false, false}, {"nested/cache1.txt", false, true}} {
		if got := searchIgnored(rules, test.path, test.dir); got != test.want {
			t.Fatalf("ignore %s: %v", test.path, got)
		}
	}
	rule, ok := searchIgnore("sub", "/note.md")
	if !ok || !searchIgnored([]searchIgnoreRule{rule}, "sub/note.md", false) || searchIgnored([]searchIgnoreRule{rule}, "other/note.md", false) {
		t.Fatal("lost relative rule base")
	}
	rule, ok = searchIgnore("", "[!a]*.md")
	if !ok || !searchIgnored([]searchIgnoreRule{rule}, "Ж.md", false) {
		t.Fatal("lost Unicode glob class")
	}
	for _, pattern := range []string{"../secret", "/", "escaped\\name", "["} {
		if _, ok := searchIgnore("", pattern); ok {
			t.Fatalf("accepted unsupported ignore %q", pattern)
		}
	}
}

func TestSearchNativeMarkdownListReadSearchParity(t *testing.T) {
	d := fixture(t)
	w := New(d.Root + "-home")
	for _, name := range []string{"README.md", "TODAY.md", "Note with spaces 🌊.md"} {
		put(t, d, name, []byte("# Known Markdown\r\nПривет 🌊\n"))
	}
	if err := os.Mkdir(filepath.Join(d.Root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, d, "sub/Nested.md", []byte("# Known Markdown"))
	put(t, d, "empty.md", []byte{})
	for generation := 0; generation < 3; generation++ {
		out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: ".", Pattern: "Markdown"})
		if err != nil {
			t.Fatal(err)
		}
		if out.ResultLimited || out.ScanLimited || len(out.Matches) != 4 || out.Binding.ApprovedRoot != d.ApprovedRoot || out.Binding.Root != d.Root {
			t.Fatalf("lost Markdown generation %d: %+v", generation, out)
		}
		listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"README.md", "TODAY.md", "Note with spaces 🌊.md"} {
			found := false
			for _, entry := range listed.Entries {
				if entry == name {
					found = true
				}
			}
			if !found {
				t.Fatalf("known Markdown absent from list: %s", name)
			}
			read, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: name})
			if err != nil || !strings.Contains(read.Text, "Markdown") {
				t.Fatalf("read %s: %v", name, err)
			}
		}
	}
	out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "sub", Pattern: "Markdown"})
	if err != nil || len(out.Matches) != 1 || out.Matches[0].Path != "sub/Nested.md" {
		t.Fatalf("relative scope: %+v %v", out, err)
	}
	out, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "empty.md", Pattern: "^"})
	if err != nil || out.Matches == nil || len(out.Matches) != 0 {
		t.Fatalf("empty file: %+v %v", out, err)
	}
}
func TestSearchNativeFiltersAndExplicitRefusals(t *testing.T) {
	d := fixture(t)
	w := New(d.Root + "-home")
	put(t, d, "visible.md", []byte("hit"))
	put(t, d, "private.md", []byte("hit"))
	put(t, d, ".env", []byte("hit synthetic"))
	put(t, d, ".SSH", []byte("hit synthetic"))
	put(t, d, "binary", []byte{'h', 'i', 't', 0})
	put(t, d, "invalid", []byte{255})
	put(t, d, "hard.md", []byte("hit"))
	put(t, d, "ignored.md", []byte("hit"))
	put(t, d, ".gitignore", []byte("ignored.md\n"))
	if err := os.Link(filepath.Join(d.Root, "hard.md"), filepath.Join(d.Root, "hard2.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("visible.md", filepath.Join(d.Root, "link.md")); err != nil {
		t.Fatal(err)
	}
	d.DeniedPaths = []string{"private.md"}
	out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: ".", Pattern: "hit"})
	if err != nil || len(out.Matches) != 1 || out.Matches[0].Path != "visible.md" {
		t.Fatalf("filtered search: %+v %v", out, err)
	}
	for _, test := range []struct{ path, code string }{{"private.md", "WORKSPACE_PATH_REFUSED"}, {".env", "WORKSPACE_PATH_REFUSED"}, {".SSH", "WORKSPACE_PATH_REFUSED"}, {"link.md", "WORKSPACE_PATH_REFUSED"}, {"hard.md", "WORKSPACE_PATH_REFUSED"}, {"binary", "WORKSPACE_NOT_TEXT"}, {"invalid", "WORKSPACE_NOT_TEXT"}, {"absent", "WORKSPACE_NOT_FOUND"}} {
		out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: test.path, Pattern: "hit"})
		if out != nil {
			t.Fatalf("disclosed %s", test.path)
		}
		expectCode(t, err, test.code)
	}
	out, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "ignored.md", Pattern: "hit"})
	if err != nil || len(out.Matches) != 1 {
		t.Fatal("explicit file failed to override ignore")
	}
	d.ExactFilePaths = []string{"visible.md"}
	out, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "visible.md", Pattern: "hit"})
	if err != nil || len(out.Matches) != 1 {
		t.Fatal("exact file failed")
	}
	_, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: ".", Pattern: "hit"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
}
func TestSearchNativeBoundsAndNestedIgnore(t *testing.T) {
	d := fixture(t)
	w := New(d.Root + "-home")
	put(t, d, "hits.md", []byte(strings.Repeat("hit\n", 101)))
	out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "hits.md", Pattern: "hit"})
	if err != nil || len(out.Matches) != 100 || !out.ResultLimited || out.ScanLimited {
		t.Fatalf("result bound: %+v %v", out, err)
	}
	file, err := os.Create(filepath.Join(d.Root, "oversized"))
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(searchFileBytes + 1)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "oversized", Pattern: "hit"})
	expectCode(t, err, "WORKSPACE_FILE_TOO_LARGE")
	out, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: ".", Pattern: "absent"})
	if err != nil || !out.ScanLimited || out.ResultLimited || len(out.Matches) != 0 {
		t.Fatalf("scan bound: %+v %v", out, err)
	}
	if err := os.Mkdir(filepath.Join(d.Root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, d, ".gitignore", []byte("*.md\n!hits.md\n"))
	put(t, d, "sub/.gitignore", []byte("!keep.md\n"))
	put(t, d, "sub/keep.md", []byte("hit"))
	put(t, d, "sub/skip.md", []byte("hit"))
	out, err = w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "sub", Pattern: "hit"})
	if err != nil || len(out.Matches) != 1 || out.Matches[0].Path != "sub/keep.md" {
		t.Fatalf("nested rules: %+v %v", out, err)
	}
}
func TestSearchNativeRaceRootAndCancellation(t *testing.T) {
	for _, kind := range []string{"same-size", "growth", "replace", "root"} {
		t.Run(kind, func(t *testing.T) {
			d := fixture(t)
			put(t, d, "note.md", []byte("hit"))
			initial := time.Unix(946684800, 0)
			if err := os.Chtimes(filepath.Join(d.Root, "note.md"), initial, initial); err != nil {
				t.Fatal(err)
			}
			w := New(d.Root + "-home")
			w.afterRead = func() {
				w.afterRead = nil
				switch kind {
				case "same-size":
					put(t, d, "note.md", []byte("new"))
				case "growth":
					put(t, d, "note.md", []byte("hit-more"))
				case "replace":
					if err := os.Rename(filepath.Join(d.Root, "note.md"), filepath.Join(d.Root, "old.md")); err != nil {
						t.Fatal(err)
					}
					put(t, d, "note.md", []byte("hit"))
				case "root":
					if err := os.Rename(d.Root, d.Root+"-old"); err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { os.RemoveAll(d.Root + "-old") })
					if err := os.Mkdir(d.Root, 0700); err != nil {
						t.Fatal(err)
					}
				}
			}
			out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "note.md", Pattern: "hit"})
			if out != nil {
				t.Fatal("raced bytes disclosed")
			}
			code := "WORKSPACE_RACE_DETECTED"
			if kind == "root" {
				code = "WORKSPACE_ROOT_CHANGED"
			}
			expectCode(t, err, code)
		})
	}
	d := fixture(t)
	put(t, d, "note.md", []byte("hit"))
	d.ApprovedRoot.Inode = "0"
	_, err := New(d.Root+"-home").Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "note.md", Pattern: "hit"})
	expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = New(d.Root+"-home").Search(ctx, port.SearchRequest{Workspace: d, RelativePath: "note.md", Pattern: "hit"})
	expectCode(t, err, "WORKSPACE_REQUEST_CANCELLED")
}
func TestSearchNativeDenialAliasesAndDirectorySwap(t *testing.T) {
	for _, test := range []struct{ name, deny string }{{"Café.md", "Café.md"}, {"STRASSE.md", "Straße.md"}} {
		t.Run(test.name, func(t *testing.T) {
			d := fixture(t)
			put(t, d, test.name, []byte("hit"))
			d.DeniedPaths = []string{test.deny}
			out, err := New(d.Root+"-home").Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: ".", Pattern: "hit"})
			if err != nil || len(out.Matches) != 0 {
				t.Fatalf("denial alias: %+v %v", out, err)
			}
		})
	}
	d := fixture(t)
	if err := os.Mkdir(filepath.Join(d.Root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, d, "sub/note.md", []byte("hit"))
	w := New(d.Root + "-home")
	w.afterRead = func() {
		w.afterRead = nil
		if err := os.Rename(filepath.Join(d.Root, "sub"), filepath.Join(d.Root, "old")); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(d.Root, "sub"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	out, err := w.Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: "sub", Pattern: "hit"})
	if out != nil {
		t.Fatal("swapped subtree disclosed")
	}
	expectCode(t, err, "WORKSPACE_RACE_DETECTED")
}
func TestSearchNativeOutputByteBudget(t *testing.T) {
	d := fixture(t)
	// Individual names stay below NAME_MAX; deep Unicode paths exercise the
	// ASCII-escaped response budget independently of the 100-result ceiling.
	parts := make([]string, 16)
	for i := range parts {
		parts[i] = strings.Repeat("🌊", 50)
	}
	nested := filepath.Join(append([]string{d.Root}, parts...)...)
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	long := "note.md"
	text := strings.Repeat(strings.Repeat("🌊", 490)+"hit\n", 100)
	if err := os.WriteFile(filepath.Join(nested, long), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := New(d.Root+"-home").Search(context.Background(), port.SearchRequest{Workspace: d, RelativePath: ".", Pattern: "hit"})
	if err != nil || !out.ResultLimited || out.ScanLimited || len(out.Matches) >= 100 || len(out.Matches) == 0 {
		t.Fatalf("serialized bound: %+v %v", out, err)
	}
	charged := 0
	for _, m := range out.Matches {
		charged += searchMatchBytes(m)
	}
	if charged > searchOutputBytes {
		t.Fatal("overflowed response envelope")
	}
}

func TestSearchPureFileAndTotalByteBounds(t *testing.T) {
	for _, test := range []struct {
		size                       int64
		explicit, allowed, limited bool
		code                       string
	}{
		{0, true, true, false, ""}, {searchFileBytes, true, true, false, ""},
		{searchFileBytes + 1, true, false, false, "WORKSPACE_FILE_TOO_LARGE"},
		{searchFileBytes + 1, false, false, true, ""}, {-1, true, false, false, "WORKSPACE_RACE_DETECTED"},
	} {
		s := pureSearch(t, "hit")
		allowed, err := s.allowBytes(test.size, searchFileBytes, test.explicit)
		if allowed != test.allowed || s.result.ScanLimited != test.limited {
			t.Fatalf("size bound %+v", test)
		}
		if test.code != "" {
			expectCode(t, err, test.code)
		} else if err != nil {
			t.Fatal(err)
		}
	}
	s := pureSearch(t, "hit")
	s.bytes = searchTotalBytes - 1
	allowed, err := s.allowBytes(2, searchFileBytes, false)
	if err != nil || allowed || !s.stop || !s.result.ScanLimited || s.result.ResultLimited {
		t.Fatal("total byte budget")
	}
	s = pureSearch(t, "hit")
	s.bytes = searchTotalBytes
	allowed, err = s.allowBytes(0, searchFileBytes, false)
	if err != nil || !allowed || s.result.ScanLimited {
		t.Fatal("empty file charged bytes")
	}
	for _, depth := range []int{searchDepth + 1, 0} {
		s := pureSearch(t, "hit")
		if depth == 0 {
			s.directories = searchDirectories
		}
		if err := s.directory(-1, nil, nil, depth); err != nil || !s.result.ScanLimited || s.result.ResultLimited {
			t.Fatal("scan bound touched directory or lost flag")
		}
	}
	// HTML characters do not consume six bytes each in Python ensure_ascii JSON.
	ascii := searchMatchBytes(port.SearchMatch{Path: "note.md", Line: 1, Text: "abc"})
	if got := searchMatchBytes(port.SearchMatch{Path: "note.md", Line: 1, Text: "<>&"}); got != ascii {
		t.Fatal("HTML escaping altered output budget")
	}
	if got := searchMatchBytes(port.SearchMatch{Path: "note.md", Line: 1, Text: "\u2028"}); got-ascii != 3 {
		t.Fatal("U+2028 was charged twice")
	}
}

package filesystem

import "testing"

func TestPathPureIgnoreRules(t *testing.T) {
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

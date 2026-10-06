package filesystem

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure parsing coverage is deliberately separate from rootpolicy_test.go's
// real descriptor opens. These assertions do not claim native file access.
func TestRootFilePolicyParsesNamesWithoutImplicitExclusions(t *testing.T) {
	for _, root := range []string{"/owner/home", "/owner/home/.ssh", "/repo"} {
		w, err := NewWithFilePolicy("/owner/home", authority.RootScopedFiles)
		if err != nil {
			t.Fatal(err)
		}
		p, err := w.parsePolicy(port.Descriptor{Root: root})
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{".env", ".env.production", ".npmrc", ".ssh/key", ".git/config", ".codex/config.toml", ".claude/settings.json"} {
			if p.denies(strings.Split(name, "/")) || !p.permitsFile(name) {
				t.Fatalf("%s/%s silently excluded", root, name)
			}
		}
	}
}

func TestRootFilePolicyParsesOnlyExplicitRestrictions(t *testing.T) {
	w, _ := NewWithFilePolicy("/owner/home", authority.RootScopedFiles)
	p, err := w.parsePolicy(port.Descriptor{Root: "/repo", DeniedPaths: []string{".env", "private", "private"}, ExactFilePaths: []string{".npmrc"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.denied) != 2 || !p.denies([]string{".ENV"}) || !p.denies([]string{"private", "data"}) || p.denies([]string{".npmrc"}) || !p.permitsFile(".npmrc") || p.permitsFile("ordinary") {
		t.Fatal("explicit denial/exact scope was weakened or duplicated")
	}
	for _, bad := range []string{"../other", "/other", "./other"} {
		if _, err := w.parsePolicy(port.Descriptor{Root: "/repo", DeniedPaths: []string{bad}}); err == nil {
			t.Fatal("bad policy path accepted")
		}
	}
}

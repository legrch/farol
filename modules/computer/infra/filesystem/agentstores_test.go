package filesystem

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
)

// Policy-only synthetic paths: these tests never open agent stores. Physical
// identity, no-follow, authority and mutation checks retain their own suites.
func TestAgentStoresFollowDescriptorPolicy(t *testing.T) {
	const home = "/Users/example"
	for _, store := range []string{".codex", ".claude", ".Codex", ".CLAUDE"} {
		t.Run(store, func(t *testing.T) {
			for _, root := range []string{home, "/Users", home + "/" + store, home + "/" + store + "/worktrees/task/repo"} {
				p, err := New(home).parsePolicy(port.Descriptor{Root: root})
				if err != nil {
					t.Fatalf("approved root %s refused: %v", root, err)
				}
				relative := "config.toml"
				if root == home {
					relative = store + "/config.toml"
				}
				if root == "/Users" {
					relative = "example/" + store + "/config.toml"
				}
				if p.denies(strings.Split(relative, "/")) || !p.permitsFile(relative) {
					t.Fatalf("agent store unexpectedly denied at %s", root)
				}
			}
		})
	}
}

func TestAgentStoreExplicitExclusionsAndExactFileScopesRemain(t *testing.T) {
	const home = "/Users/example"
	for _, store := range []string{".codex", ".claude"} {
		t.Run(store, func(t *testing.T) {
			d := port.Descriptor{Root: home, DeniedPaths: []string{store}}
			p, err := New(home).parsePolicy(d)
			if err != nil {
				t.Fatal(err)
			}
			if !p.denies([]string{strings.ToUpper(store), "session.jsonl"}) {
				t.Fatal("explicit normalized exclusion lost")
			}
			d = port.Descriptor{Root: home + "/" + store, DeniedPaths: []string{"private"}, ExactFilePaths: []string{"selected.txt"}}
			p, err = New(home).parsePolicy(d)
			if err != nil {
				t.Fatal(err)
			}
			if !p.denies([]string{"private", "value"}) || !p.permitsFile("selected.txt") || p.permitsFile("other.txt") {
				t.Fatal("descriptor scope widened")
			}
			d.ExactFilePaths = []string{}
			p, err = New(home).parsePolicy(d)
			if err != nil || p.permitsFile("selected.txt") {
				t.Fatal("empty exact-file grant widened", err)
			}
		})
	}
}

func TestAgentStoreChangePreservesOtherMandatoryStores(t *testing.T) {
	const home = "/Users/example"
	w := New(home)
	p, err := w.parsePolicy(port.Descriptor{Root: home})
	if err != nil {
		t.Fatal(err)
	}
	for _, store := range []string{".ssh", ".AWS", ".gnupg", "Library/Keychains"} {
		if !p.denies(strings.Split(store+"/value", "/")) {
			t.Fatal("mandatory denial lost", store)
		}
		_, err := w.parsePolicy(port.Descriptor{Root: home + "/" + store + "/.codex"})
		expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	}
}

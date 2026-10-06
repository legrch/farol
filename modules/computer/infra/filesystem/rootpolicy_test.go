package filesystem

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// Reads/lists use real disposable filesystem descriptors. Mutation cases use the
// existing explicitly labelled syscall model: they are not native-write evidence.
func TestRootFilePolicyReadsAndListsApprovedNames(t *testing.T) {
	d := fixture(t)
	w, err := NewWithFilePolicy(d.Root, authority.RootScopedFiles)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".env", ".npmrc", ".git-credentials", ".netrc"} {
		put(t, d, name, []byte("SYNTHETIC_OWNER_APPROVED\n"))
		got, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: name})
		if err != nil || got.Text != "SYNTHETIC_OWNER_APPROVED\n" {
			t.Fatalf("%s: %v", name, err)
		}
	}
	listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil || listed.Truncated {
		t.Fatal(err)
	}
	for _, name := range []string{".env", ".npmrc", ".git-credentials", ".netrc"} {
		if !slices.Contains(listed.Entries, name) {
			t.Fatalf("approved name hidden: %s", name)
		}
	}
	for _, dir := range []string{".ssh", ".git", ".codex", ".claude"} {
		if err := os.Mkdir(filepath.Join(d.Root, dir), 0700); err != nil {
			t.Fatal(err)
		}
		put(t, d, dir+"/fixture", []byte("SYNTHETIC\n"))
		if _, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: dir + "/fixture"}); err != nil {
			t.Fatal(dir, err)
		}
	}
	// Existing persisted callers do not silently acquire the new semantics.
	_, err = New(d.Root).Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: ".env"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
}

func TestRootFilePolicyStillEnforcesExplicitScopeAndPhysicalBoundary(t *testing.T) {
	d := fixture(t)
	w, err := NewWithFilePolicy(d.Root, authority.RootScopedFiles)
	if err != nil {
		t.Fatal(err)
	}
	put(t, d, ".env", []byte("SYNTHETIC\n"))
	d.DeniedPaths = []string{".env"}
	_, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: ".env"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	d.DeniedPaths = nil
	d.ExactFilePaths = []string{"other"}
	if _, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: ".env"}); err == nil {
		t.Fatal("exact-file scope widened")
	}
	d.ExactFilePaths = nil
	for _, name := range []string{"../outside", "/outside", "nested/../.env"} {
		if _, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: name}); err == nil {
			t.Fatalf("invalid path accepted: %s", name)
		}
	}
	if err := os.Symlink(".env", filepath.Join(d.Root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "link"}); err == nil {
		t.Fatal("unsandboxed File API followed a link")
	}
	d.ApprovedRoot.Inode = "0"
	if _, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: ".env"}); err == nil {
		t.Fatal("physical root identity ignored")
	}
}

func TestRootFilePolicyRejectsUnknownSelection(t *testing.T) {
	if _, err := NewWithFilePolicy("/home/test", "full-access-typo"); err == nil {
		t.Fatal("unknown policy accepted")
	}
	if _, err := NewMutableWithFilePolicy("/home/test", "full-access-typo"); err == nil {
		t.Fatal("unknown mutable policy accepted")
	}
	if _, err := NewWithFilePolicy("../home", authority.RootScopedFiles); err == nil {
		t.Fatal("invalid host accepted")
	}
}

func TestRootFilePolicyMutationPreservesCASAndPublicationGuard(t *testing.T) {
	for _, name := range []string{".env", ".npmrc", ".git-credentials"} {
		t.Run(name, func(t *testing.T) {
			m, f := fakeMutable()
			m.filePolicy = authority.RootScopedFiles
			request := fakeRequest(mutation.Write{RelativePath: name, Content: "SYNTHETIC\n"})
			if _, err := m.Mutate(context.Background(), request); err != nil {
				t.Fatal(err)
			}
			if string(f.work.children[name].data) != "SYNTHETIC\n" {
				t.Fatal("approved name not written")
			}
			request.Operation = mutation.Edit{RelativePath: name, ExpectedSHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("SYNTHETIC\n"))), Edits: []mutation.TextEdit{{OldText: "SYNTHETIC", NewText: "EDITED"}}}
			if _, err := m.Mutate(context.Background(), request); err != nil {
				t.Fatal(err)
			}
			before := string(f.work.children[name].data)
			if _, err := m.Mutate(context.Background(), request); err == nil {
				t.Fatal("stale edit accepted")
			}
			if string(f.work.children[name].data) != before {
				t.Fatal("stale edit changed bytes")
			}
		})
	}
	for _, reason := range []string{"write-exclusion", "no-guard", "wrong-root"} {
		t.Run(reason, func(t *testing.T) {
			m, f := fakeMutable()
			m.filePolicy = authority.RootScopedFiles
			request := fakeRequest(mutation.Write{RelativePath: ".env", Content: "SYNTHETIC"})
			switch reason {
			case "write-exclusion":
				request.Workspace.WriteDeniedPaths = []string{".env"}
			case "no-guard":
				request.BeforePublish = nil
			case "wrong-root":
				request.Workspace.ApprovedRoot.Inode = "9999"
			}
			if _, err := m.Mutate(context.Background(), request); err == nil {
				t.Fatal("mutation guard bypassed")
			}
			if f.swaps != 0 || f.links != 0 {
				t.Fatal("refused operation published")
			}
		})
	}
}

func TestRootFilePolicyAllowsGitNamesButNotExplicitDeniedMetadata(t *testing.T) {
	m, _ := fakeMutable()
	m.filePolicy = authority.RootScopedFiles
	d := fakeRequest(mutation.Write{}).Workspace
	for _, path := range []string{".git/config", "nested/.git/config", ".ssh/key"} {
		if err := m.policy(d, path); err != nil {
			t.Fatal(path, err)
		}
	}
	d.WriteDeniedPaths = []string{".git"}
	if err := m.policy(d, ".git/config"); err == nil {
		t.Fatal("explicit metadata denial removed")
	}
	legacy, _ := fakeMutable()
	if err := legacy.policy(fakeRequest(mutation.Write{}).Workspace, "nested/.git/config"); err == nil {
		t.Fatal("legacy metadata protection changed")
	}
	m.filePolicy = authority.FilePolicy(strings.Repeat("?", 2))
	if err := m.policy(d, "ordinary"); err == nil {
		t.Fatal("invalid constructor state accepted")
	}
}

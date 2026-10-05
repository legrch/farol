package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Pure synthetic path policy only. Native filesystem cases have separate names.
func TestRepositoryConfigPureOrdinaryRoots(t *testing.T) {
	const home = "/Users/example"
	w := New(home)
	for _, root := range []string{"/repo", home + "/code/repo", home + "/code/repo/.NPMRC", home + "/code/repo/.npmrc/child", home + "grown"} {
		p, err := w.parsePolicy(port.Descriptor{Root: root})
		if err != nil {
			t.Fatal(root, err)
		}
		var denied []string
		for _, parts := range p.denied {
			denied = append(denied, strings.Join(parts, "/"))
		}
		want := ".env,.ssh,.aws,.gnupg,.git,.git-credentials,.netrc,.pypirc,.docker/config.json,.kube/config,Library/Keychains"
		if strings.Join(denied, ",") != want {
			t.Fatal("root mandatory list changed beyond .npmrc", denied)
		}
		for _, relative := range []string{".npmrc", ".NPMRC", "nested/.npmrc"} {
			if p.denies(strings.Split(relative, "/")) || !p.permitsFile(relative) {
				t.Fatal("ordinary repository config denied", root, relative)
			}
		}
	}
}

func TestRepositoryConfigPureHomeAndExclusions(t *testing.T) {
	const home = "/Users/example"
	w := New(home)
	for _, root := range []string{home, "/Users", "/USERS/EXAMPLE"} {
		p, err := w.parsePolicy(port.Descriptor{Root: root})
		if err != nil {
			t.Fatal(err)
		}
		prefix := ""
		if root == "/Users" {
			prefix = "EXAMPLE/"
		}
		if !p.denies(strings.Split(prefix+".NPMRC", "/")) || p.denies(strings.Split(prefix+"code/repo/.npmrc", "/")) {
			t.Fatal("HOME-only denial misplaced", root)
		}
	}
	for _, root := range []string{home + "/.npmrc", "/USERS/EXAMPLE/.NPMRC", home + "/.NPMRC/child/repo"} {
		_, err := w.parsePolicy(port.Descriptor{Root: root})
		expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	}
	for _, exclusion := range []string{".npmrc", "nested/.NPMRC", "nested"} {
		p, err := w.parsePolicy(port.Descriptor{Root: "/repo", DeniedPaths: []string{exclusion}, ExactFilePaths: []string{exclusion}})
		if err != nil || !p.denies(strings.Split(strings.ToUpper(exclusion), "/")) {
			t.Fatal("exact-file scope bypassed exclusion", exclusion, err)
		}
	}
}

func TestRepositoryConfigPureMutationPolicy(t *testing.T) {
	m := &Mutable{home: "/Users/example"} // No syscall adapter selected.
	d := port.MutationDescriptor{Root: "/Users/example/code/repo"}
	for _, path := range []string{".npmrc", "nested/.NPMRC"} {
		if err := m.policy(d, path); err != nil {
			t.Fatal("repository mutation blanket-denied", err)
		}
		for _, writeOnly := range []bool{false, true} {
			excluded := d
			if writeOnly {
				excluded.WriteDeniedPaths = []string{strings.ToUpper(path)}
			} else {
				excluded.DeniedPaths = []string{strings.ToUpper(path)}
			}
			expectCode(t, m.policy(excluded, path), "WORKSPACE_PATH_REFUSED")
		}
	}
	d.Root = "/Users/example"
	expectCode(t, m.policy(d, ".NPMRC"), "WORKSPACE_PATH_REFUSED")
	d.Root = "/Users"
	expectCode(t, m.policy(d, "EXAMPLE/.npmrc"), "WORKSPACE_PATH_REFUSED")
	for _, path := range []string{".git/config", "nested/.GIT/config", ".ssh/config"} {
		d.Root = "/repo"
		expectCode(t, m.policy(d, path), "WORKSPACE_PATH_REFUSED")
	}
}

// Native tests require a separate Lead grant. Pure runs use an anchored name
// selection excluding every TestRepositoryConfigNative case. Fixtures use a
// synthetic HOME under a disposable approved root, never owner HOME or profiles.
func repositoryConfigNativeFixture(t *testing.T) (port.Descriptor, string, string) {
	t.Helper()
	d := fixture(t)
	home := filepath.Join(d.Root, "home")
	repo := filepath.Join(home, "code", "repo")
	if err := os.MkdirAll(repo, 0700); err != nil {
		t.Fatal(err)
	}
	return d, home, repo
}

func repositoryConfigNativeMutation(d port.Descriptor, op mutation.Operation) port.MutationRequest {
	return port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: d.WorkspaceID, Root: d.Root, ApprovedRoot: d.ApprovedRoot, DeniedPaths: d.DeniedPaths},
		Operation: op, BeforePublish: func(context.Context) error { return nil }} // Synthetic lease double, not admission proof.
}

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

func repositoryConfigNativeRefused(t *testing.T, home string, d port.Descriptor, path string) {
	t.Helper()
	w, m := New(home), NewMutable(home)
	read, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: path})
	if read != nil {
		t.Fatal("refused config disclosed response")
	}
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	for _, op := range []mutation.Operation{
		mutation.Write{RelativePath: path, Content: "blocked"},
		mutation.Edit{RelativePath: path, ExpectedSHA256: payloadHash([]byte("synthetic-marker\n")), Edits: []mutation.TextEdit{{OldText: "synthetic", NewText: "blocked"}}},
	} {
		receipt, err := m.Mutate(context.Background(), repositoryConfigNativeMutation(d, op))
		if receipt != nil {
			t.Fatal("refused config returned mutation receipt")
		}
		expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	}
}

func TestRepositoryConfigNativeHomeExclusionsAndAliases(t *testing.T) {
	d, home, repo := repositoryConfigNativeFixture(t)
	put(t, d, "home/.npmrc", []byte("synthetic-marker\n"))
	put(t, d, "home/code/repo/.npmrc", []byte("synthetic-marker\n"))
	for _, selected := range []struct{ root, path string }{{d.Root, "home/.NPMRC"}, {home, ".npmrc"}, {repo, ".npmrc"}} {
		target := d
		target.Root = selected.root
		if selected.root == repo {
			target.DeniedPaths = []string{".NPMRC"}
		}
		repositoryConfigNativeRefused(t, home, target, selected.path)
		searched, err := New(home).Search(context.Background(), port.SearchRequest{Workspace: target, RelativePath: selected.path, Pattern: "synthetic-marker"})
		if searched != nil {
			t.Fatal("refused config search disclosed response")
		}
		expectCode(t, err, "WORKSPACE_PATH_REFUSED")
		listed, err := New(home).List(context.Background(), port.ListRequest{Workspace: target, RelativePath: "."})
		if err != nil || slices.Contains(listed.Entries, ".npmrc") {
			t.Fatal("protected/excluded file listed", err)
		}
	}
	target := d
	target.Root = filepath.Join(home, ".npmrc")
	_, err := New(home).List(context.Background(), port.ListRequest{Workspace: target, RelativePath: "."})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	if err := os.Remove(target.Root); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".NPMRC", "child", "repo"), 0700); err != nil {
		t.Fatal(err)
	}
	target.Root = filepath.Join(home, ".NPMRC", "child", "repo")
	repositoryConfigNativeRefused(t, home, target, "config.txt")
}

func TestRepositoryConfigNativeLinksAndRootReplacement(t *testing.T) {
	d, home, repo := repositoryConfigNativeFixture(t)
	put(t, d, "home/.npmrc", []byte("synthetic-marker\n"))
	if err := os.Symlink(filepath.Join(home, ".npmrc"), filepath.Join(repo, ".npmrc")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(home, ".npmrc"), filepath.Join(repo, "hard.npmrc")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(home, filepath.Join(repo, "alias")); err != nil {
		t.Fatal(err)
	}
	d.Root = repo
	for _, path := range []string{".npmrc", "hard.npmrc", "alias/.npmrc"} {
		repositoryConfigNativeRefused(t, home, d, path)
	}
	// Bind to the repo itself before replacing that approved object.
	d.ApprovedRoot = port.Root{Path: repo}
	var info unix.Stat_t
	if err := unix.Lstat(repo, &info); err != nil {
		t.Fatal(err)
	}
	d.ApprovedRoot.Device, d.ApprovedRoot.Inode = strconv.FormatUint(uint64(info.Dev), 10), strconv.FormatUint(uint64(info.Ino), 10)
	if err := os.Rename(repo, repo+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	_, err := New(home).Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: ".npmrc"})
	expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
}

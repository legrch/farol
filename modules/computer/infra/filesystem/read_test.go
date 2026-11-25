package filesystem

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"golang.org/x/sys/unix"
)

func fixture(t *testing.T) port.Descriptor {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	var info unix.Stat_t
	if err := unix.Lstat(root, &info); err != nil {
		t.Fatal(err)
	}
	return port.Descriptor{WorkspaceID: "fixture", Root: root, ApprovedRoot: port.Root{Path: root, Device: strconv.FormatUint(uint64(info.Dev), 10), Inode: strconv.FormatUint(uint64(info.Ino), 10)}}
}
func put(t *testing.T, d port.Descriptor, name string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(d.Root, name), raw, 0600); err != nil {
		t.Fatal(err)
	}
}
func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *authority.Failure
	if !errors.As(err, &failure) || failure.Code != code || failure.Retry != "never" {
		t.Fatalf("want %s/never, got %v", code, err)
	}
}

func TestReadRawDigestAndBOM(t *testing.T) {
	d := fixture(t)
	raw := append([]byte{0xef, 0xbb, 0xbf}, []byte("# Brain\nПривет 🌊\n")...)
	put(t, d, "note.md", raw)
	out, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	if out.Text != string(raw[3:]) || out.Bytes != uint64(len(raw)) || out.SHA256 != hex.EncodeToString(digest[:]) || out.Page != nil {
		t.Fatalf("wrong exact-byte result: %+v", out)
	}
}
func TestReadRangeWholeCharacters(t *testing.T) {
	d := fixture(t)
	text := "a🌊bЖc"
	put(t, d, "note.md", []byte(text))
	w := New(d.Root + "-home")
	var built strings.Builder
	offset := uint64(0)
	for calls := 0; calls < 10; calls++ {
		out, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md", Range: &port.Range{Offset: offset, Length: 4}})
		if err != nil {
			t.Fatal(err)
		}
		if out.SHA256 != "" || out.Page == nil {
			t.Fatal("window claimed full digest")
		}
		built.WriteString(out.Text)
		if out.Page.NextOffset == nil {
			break
		}
		if *out.Page.NextOffset <= offset {
			t.Fatal("window made no progress")
		}
		offset = *out.Page.NextOffset
	}
	if built.String() != text {
		t.Fatalf("got %q", built.String())
	}
	out, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md", Range: &port.Range{Offset: 2, Length: 4}})
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "b" || out.Page.Offset != 5 || out.Bytes != 1 {
		t.Fatalf("unaligned result %+v", out)
	}
	out, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md", Range: &port.Range{Offset: 100, Length: 4}})
	if err != nil || out.Page.NextOffset != nil || out.Text != "" {
		t.Fatalf("EOF: %+v %v", out, err)
	}
}
func TestReadRangeRejectsChangedSnapshot(t *testing.T) {
	for _, change := range []struct {
		name string
		text string
	}{
		{"same-size overwrite", "ABCDEFGH"},
		{"growth", "abcdefgh-more"},
		{"truncation", "abc"},
	} {
		t.Run(change.name, func(t *testing.T) {
			d := fixture(t)
			put(t, d, "note.md", []byte("abcdefgh"))
			// A fixed initial mtime makes the native metadata change deterministic.
			initial := time.Unix(946684800, 0)
			if err := os.Chtimes(filepath.Join(d.Root, "note.md"), initial, initial); err != nil {
				t.Fatal(err)
			}
			w := New(d.Root + "-home")
			w.afterRead = func() { put(t, d, "note.md", []byte(change.text)) }
			out, err := w.Read(context.Background(), port.ReadRequest{
				Workspace: d, RelativePath: "note.md", Range: &port.Range{Offset: 2, Length: 4},
			})
			if out != nil {
				t.Fatalf("range disclosed a changed snapshot: %+v", out)
			}
			expectCode(t, err, "WORKSPACE_RACE_DETECTED")
		})
	}
}
func TestReadRefusals(t *testing.T) {
	d := fixture(t)
	put(t, d, "denied.md", []byte("secret"))
	d.DeniedPaths = []string{"denied.md"}
	cases := []struct {
		name string
		raw  []byte
		code string
	}{{"invalid.md", []byte{0xff}, "WORKSPACE_NOT_TEXT"}, {"nul.md", []byte{'a', 0}, "WORKSPACE_NOT_TEXT"}, {"truncated.md", []byte{0xf0, 0x9f}, "WORKSPACE_NOT_TEXT"}, {"large.md", make([]byte, maxReadBytes+1), "WORKSPACE_FILE_TOO_LARGE"}}
	for _, c := range cases {
		put(t, d, c.name, c.raw)
		out, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: c.name})
		if out != nil {
			t.Fatal("failure disclosed response")
		}
		expectCode(t, err, c.code)
	}
	for _, path := range []string{"../escape", "/absolute", "a/../denied.md", "a\\b"} {
		_, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: path})
		expectCode(t, err, "WORKSPACE_INVALID_REQUEST")
	}
	_, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "denied.md"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	_, err = New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "missing.md"})
	expectCode(t, err, "WORKSPACE_NOT_FOUND")
	d.ExactFilePaths = []string{}
	_, err = New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "denied.md"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
}

func TestReadPathRefusalReportsSafeReason(t *testing.T) {
	for _, scenario := range []struct{ name, stage, reason string }{
		{"policy", "policy", "policy_denied"},
		{"symlink", "target", "link_not_supported"},
		{"hardlink", "target", "hardlink_not_supported"},
		{"ancestor-symlink", "ancestor", "link_not_supported"},
		{"unsafe-root", "root", "unsafe_root"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			d := fixture(t)
			put(t, d, "original.md", []byte("disposable"))
			name := "original.md"
			switch scenario.name {
			case "policy":
				d.DeniedPaths = []string{name}
			case "symlink":
				name = "link.md"
				if err := os.Symlink("original.md", filepath.Join(d.Root, name)); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				name = "hard.md"
				if err := os.Link(filepath.Join(d.Root, "original.md"), filepath.Join(d.Root, name)); err != nil {
					t.Fatal(err)
				}
			case "ancestor-symlink":
				if err := os.Mkdir(filepath.Join(d.Root, "real"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("real", filepath.Join(d.Root, "alias")); err != nil {
					t.Fatal(err)
				}
				name = "alias/note.md"
			case "unsafe-root":
				// Owner decision D49: a root other users can write to is allowed; a
				// root that another user owns is the unsafe one.
				d = foreignOwnedRoot(t)
			}
			out, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: name})
			var failure *authority.Failure
			if out != nil || !errors.As(err, &failure) || failure.Code != "WORKSPACE_PATH_REFUSED" || failure.Retry != "never" || failure.Stage != scenario.stage || failure.Reason != scenario.reason {
				t.Fatalf("wrong refusal: %+v, %v", out, err)
			}
		})
	}
}

func TestOpenPermissionErrorsAreClassifiedWithoutRawDetails(t *testing.T) {
	for _, cause := range []error{unix.EACCES, unix.EPERM} {
		var failure *authority.Failure
		if !errors.As(openAtError(cause, "target"), &failure) || failure.Code != "WORKSPACE_PATH_REFUSED" || failure.Stage != "target" || failure.Reason != "os_permission_denied" || failure.Retry != "never" {
			t.Fatalf("wrong permission classification: %+v", failure)
		}
	}
	expectCode(t, openAtError(unix.ENOENT, "target"), "WORKSPACE_NOT_FOUND")
}

func TestDiagnosticPolicyChecksScopeWithoutOpeningTarget(t *testing.T) {
	d := fixture(t)
	w := New(d.Root + "-home")
	request := port.ReadRequest{Workspace: d, RelativePath: "missing.md"}
	if err := w.AuthorizeReadDiagnostic(context.Background(), request); err != nil {
		t.Fatalf("policy tried to open missing target: %v", err)
	}
	request.Workspace.DeniedPaths = []string{"missing.md"}
	expectCode(t, w.AuthorizeReadDiagnostic(context.Background(), request), "WORKSPACE_PATH_REFUSED")
	request.Workspace.DeniedPaths = nil
	request.Workspace.ExactFilePaths = []string{}
	expectCode(t, w.AuthorizeReadDiagnostic(context.Background(), request), "WORKSPACE_PATH_REFUSED")
	request.Workspace.ExactFilePaths = nil
	request.RelativePath = ".env"
	expectCode(t, w.AuthorizeReadDiagnostic(context.Background(), request), "WORKSPACE_PATH_REFUSED")
}
func TestReadRejectsLinksAndFIFO(t *testing.T) {
	d := fixture(t)
	put(t, d, "note.md", []byte("note"))
	if err := os.Symlink("note.md", filepath.Join(d.Root, "link.md")); err != nil {
		t.Fatal(err)
	}
	_, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "link.md"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	if err := os.Link(filepath.Join(d.Root, "note.md"), filepath.Join(d.Root, "hard.md")); err != nil {
		t.Fatal(err)
	}
	_, err = New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "hard.md"})
	expectCode(t, err, "WORKSPACE_PATH_REFUSED")
	if err := unix.Mkfifo(filepath.Join(d.Root, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "fifo"})
	expectCode(t, err, "WORKSPACE_NOT_A_FILE")
}
func TestNativeRootBoundaryRejectsFilesystemRootBeforeDisclosure(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*port.Descriptor)
	}{
		{"selected root", func(d *port.Descriptor) { d.Root, d.ApprovedRoot.Path = "/", "/" }},
		{"approved ancestor", func(d *port.Descriptor) { d.ApprovedRoot.Path = "/" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			d := fixture(t)
			put(t, d, "note.md", []byte("disposable"))
			home := d.Root + "-home"
			test.change(&d)
			w := New(home)
			w.afterRead = func() { t.Fatal("unsupported root reached native disclosure") }
			read, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
			if read != nil {
				t.Fatal("unsupported native root disclosed a read response")
			}
			expectCode(t, err, "WORKSPACE_INVALID_REQUEST")
			listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
			if listed != nil {
				t.Fatal("unsupported native root disclosed a list response")
			}
			expectCode(t, err, "WORKSPACE_INVALID_REQUEST")
		})
	}
}
func TestReadRootReplacementAndSnapshotRace(t *testing.T) {
	d := fixture(t)
	put(t, d, "note.md", []byte("before"))
	w := New(d.Root + "-home")
	w.afterRead = func() { put(t, d, "note.md", []byte("changed")) }
	out, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	if out != nil {
		t.Fatal("mixed snapshot disclosed")
	}
	expectCode(t, err, "WORKSPACE_RACE_DETECTED")
	moved := d.Root + "-retained"
	if err := os.Rename(d.Root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(moved) })
	if err := os.Mkdir(d.Root, 0700); err != nil {
		t.Fatal(err)
	}
	put(t, d, "note.md", []byte("replacement"))
	// Path-bound approval (owner decision 2026-11-22): the folder now at the
	// approved path is the workspace; the stale saved pair no longer refuses.
	replaced, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	if err != nil || replaced == nil || replaced.Text != "replacement" {
		t.Fatalf("folder at the approved path not read: %v", err)
	}
}
func TestReadRechecksNamedRootAfterNativeYield(t *testing.T) {
	d := fixture(t)
	put(t, d, "note.md", []byte("before"))
	w := New(d.Root + "-home")
	moved := d.Root + "-retained"
	t.Cleanup(func() { os.RemoveAll(moved) })
	w.afterRead = func() {
		if err := os.Rename(d.Root, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(d.Root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	out, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	if out != nil {
		t.Fatal("stale root disclosed")
	}
	expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
}
func TestReadCancellationAndNarrowedRoot(t *testing.T) {
	d := fixture(t)
	if err := os.Mkdir(filepath.Join(d.Root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	d.Root = filepath.Join(d.Root, "sub")
	put(t, d, "note.md", []byte("narrow"))
	if _, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := New(d.Root+"-home").Read(ctx, port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	expectCode(t, err, "WORKSPACE_REQUEST_CANCELLED")
}

// Path-bound approval (owner decision 2026-11-22): with a saved pair from
// before a renumbering reboot, Inspect still succeeds and reports the
// approved root's live identity as this operation's witness, keeping the
// saved pair only as the approval record.
func TestInspectReportsLiveApprovedRootWitnessForStaleSavedPair(t *testing.T) {
	d := fixture(t)
	live := d.ApprovedRoot
	d.ApprovedRoot.Device, d.ApprovedRoot.Inode = "1", "1"
	binding, err := New(d.Root+"-home").Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
	if err != nil || binding == nil {
		t.Fatalf("stale saved pair refused: %v", err)
	}
	if binding.ApprovedRoot != d.ApprovedRoot {
		t.Fatalf("approval record changed: %+v", binding.ApprovedRoot)
	}
	if binding.ApprovedPhysical != live || binding.Physical != live {
		t.Fatalf("live witness missing: approved %+v, physical %+v, want %+v", binding.ApprovedPhysical, binding.Physical, live)
	}
}

// A narrowed operation (effective root below the approved ancestor) must
// refuse when the ancestor is replaced while the effective subtree keeps its
// identity: the same subtree moved under a different approved directory.
func TestNarrowedReadAndInspectRefuseReplacedApprovedAncestor(t *testing.T) {
	for _, op := range []string{"read", "inspect"} {
		t.Run(op, func(t *testing.T) {
			base := fixture(t)
			approved := filepath.Join(base.Root, "approved")
			sub := filepath.Join(approved, "sub")
			if err := os.MkdirAll(sub, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(sub, "AGENTS.md"), []byte("rules"), 0600); err != nil {
				t.Fatal(err)
			}
			var info unix.Stat_t
			if err := unix.Lstat(approved, &info); err != nil {
				t.Fatal(err)
			}
			d := port.Descriptor{WorkspaceID: "fixture", Root: sub, ApprovedRoot: port.Root{Path: approved, Device: strconv.FormatUint(uint64(info.Dev), 10), Inode: strconv.FormatUint(uint64(info.Ino), 10)}}
			w := New(base.Root + "-home")
			w.afterRead = func() {
				previous := approved + "-previous"
				if err := os.Rename(approved, previous); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(approved, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(previous, "sub"), sub); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			if op == "read" {
				var out *port.ReadResponse
				out, err = w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "AGENTS.md"})
				if out != nil {
					t.Fatal("read over a replaced ancestor disclosed")
				}
			} else {
				var out *port.DirectoryBinding
				out, err = w.Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
				if out != nil {
					t.Fatal("inspection over a replaced ancestor disclosed")
				}
			}
			expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
		})
	}
}

func TestReadReportsLiveRootWitness(t *testing.T) {
	d := fixture(t)
	put(t, d, "note.md", []byte("text"))
	live := d.ApprovedRoot
	d.ApprovedRoot.Device, d.ApprovedRoot.Inode = "1", "1"
	out, err := New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	if err != nil || out == nil || out.Physical != live || out.ApprovedPhysical != live {
		t.Fatalf("read witness missing or stale: %+v %v", out, err)
	}
}

// A missing file read from a temporarily swapped tree must not be reported as
// missing from the approved tree: the root recheck runs on negative results.
func TestReadMissingFromSwappedTreeReportsRootChange(t *testing.T) {
	d := fixture(t)
	put(t, d, "AGENTS.md", []byte("rules"))
	original, swapped := d.Root+"-original", d.Root+"-swapped"
	t.Cleanup(func() { _ = os.RemoveAll(original); _ = os.RemoveAll(swapped) })
	// Tree B (empty) sits at the path when the read opens its root ...
	if err := os.Rename(d.Root, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(d.Root, 0700); err != nil {
		t.Fatal(err)
	}
	w := New(d.Root + "-home")
	// ... and the approved tree A is back before the read reports.
	w.beforeTarget = func() {
		if err := os.Rename(d.Root, swapped); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(original, d.Root); err != nil {
			t.Fatal(err)
		}
	}
	out, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "AGENTS.md"})
	if out != nil {
		t.Fatal("swapped tree disclosed")
	}
	expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
}

// foreignOwnedRoot describes /usr, a directory the current user does not own on
// any supported host. It is unavailable to a process that runs as root.
func foreignOwnedRoot(t *testing.T) port.Descriptor {
	t.Helper()
	if os.Getuid() == 0 {
		t.Skip("running as root: no system directory is foreign-owned")
	}
	var info unix.Stat_t
	if err := unix.Lstat("/usr", &info); err != nil || info.Uid == uint32(os.Getuid()) || info.Mode&unix.S_IFMT != unix.S_IFDIR {
		t.Skip("/usr is not a foreign-owned directory on this host")
	}
	return port.Descriptor{WorkspaceID: "foreign", Root: "/usr", ApprovedRoot: port.Root{Path: "/usr", Device: strconv.FormatUint(uint64(info.Dev), 10), Inode: strconv.FormatUint(info.Ino, 10)}}
}

// Owner decision D49 (2026-11-25): a workspace root owned by the current user is
// allowed even when other local users can write to it, and is marked so the UI
// can warn. Ownership by another user stays refused.
func TestWorkspaceRootWritableByOthersIsAllowedAndMarked(t *testing.T) {
	for _, test := range []struct {
		mode     os.FileMode
		writable bool
	}{{0700, false}, {0755, false}, {0770, true}, {0775, true}, {0707, true}, {0777, true}} {
		t.Run(test.mode.String(), func(t *testing.T) {
			d := fixture(t)
			put(t, d, "note.md", []byte("disposable"))
			if err := os.Chmod(d.Root, test.mode); err != nil {
				t.Fatal(err)
			}
			w := New(d.Root + "-home")
			binding, err := w.Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
			if err != nil || binding == nil || binding.WritableByOthers != test.writable {
				t.Fatalf("inspect: %+v %v", binding, err)
			}
			listed, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
			if err != nil || listed.Binding == nil || listed.Binding.WritableByOthers != test.writable {
				t.Fatalf("list: %+v %v", listed, err)
			}
			read, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
			if err != nil || read.Text != "disposable" {
				t.Fatalf("read: %+v %v", read, err)
			}
		})
	}
}

func TestWorkspaceRootOwnedByAnotherUserIsStillRefused(t *testing.T) {
	d := foreignOwnedRoot(t)
	w := New(d.Root + "-home")
	for name, call := range map[string]func() error{
		"inspect": func() error {
			_, err := w.Inspect(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
			return err
		},
		"list": func() error {
			_, err := w.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."})
			return err
		},
		"read": func() error {
			_, err := w.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			var failure *authority.Failure
			err := call()
			if !errors.As(err, &failure) || failure.Code != "WORKSPACE_PATH_REFUSED" || failure.Stage != "root" || failure.Reason != "unsafe_root" {
				t.Fatalf("foreign-owned root accepted or misclassified: %v", err)
			}
		})
	}
}

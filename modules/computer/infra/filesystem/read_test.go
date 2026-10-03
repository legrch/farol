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
	_, err = New(d.Root+"-home").Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "note.md"})
	expectCode(t, err, "WORKSPACE_ROOT_CHANGED")
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

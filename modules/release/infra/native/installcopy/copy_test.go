//go:build linux || darwin

package installcopy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type fixture struct {
	source, destination string
	a, b                Directory
}

func setup(t *testing.T) fixture {
	t.Helper()
	base := t.TempDir()
	f := fixture{source: filepath.Join(base, "source"), destination: filepath.Join(base, "destination")}
	for _, p := range []string{f.source, f.destination} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.a = openDirectory(t, f.source)
	f.b = openDirectory(t, f.destination)
	return f
}
func openDirectory(t *testing.T, p string) Directory {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	var s unix.Stat_t
	if err := unix.Fstat(int(f.Fd()), &s); err != nil {
		t.Fatal(err)
	}
	return Directory{f, metadata(s).identity()}
}
func (f fixture) prepare(t *testing.T, fence Fence) *Operation {
	t.Helper()
	if fence == nil {
		fence = func(context.Context) error { return nil }
	}
	op, err := Prepare(f.a, f.b, time.Now().Add(time.Minute), fence)
	if err != nil {
		t.Fatal(err)
	}
	return op
}
func put(t *testing.T, p, data string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(p, []byte(data), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}
func failure(t *testing.T, err error, code string, uncertain, internal bool) *Failure {
	t.Helper()
	f, ok := err.(*Failure)
	if !ok || f.Code != "launch_copy_"+code || f.Uncertain != uncertain || f.Internal != internal {
		t.Fatalf("failure = %#v, want %s uncertain=%v internal=%v", err, code, uncertain, internal)
	}
	return f
}
func TestDisposableTreeCopy(t *testing.T) {
	f := setup(t)
	if err := os.Mkdir(filepath.Join(f.source, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(f.source, "nested", "run"), "#!/bin/sh\nexit 0\n", 0751)
	put(t, filepath.Join(f.source, "z"), "", 0600)
	put(t, filepath.Join(f.source, "é😀"), "unicode", 0400)
	if err := os.Symlink("nested/run", filepath.Join(f.source, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../outside", filepath.Join(f.source, "literal")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(f.source, "nested"), 0750); err != nil {
		t.Fatal(err)
	}
	var fences int
	op := f.prepare(t, func(ctx context.Context) error {
		fences++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("fence lacks original deadline")
		}
		return nil
	})
	if err := op.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fences != 2 {
		t.Fatalf("fences=%d", fences)
	}
	for _, name := range []string{"nested/run", "z", "é😀"} {
		a, err := os.ReadFile(filepath.Join(f.source, name))
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(f.destination, name))
		if err != nil || !bytes.Equal(a, b) {
			t.Fatalf("content %s: %q %v", name, b, err)
		}
		x, _ := os.Stat(filepath.Join(f.source, name))
		y, _ := os.Stat(filepath.Join(f.destination, name))
		if x.Mode() != y.Mode() {
			t.Fatalf("mode %s: %v != %v", name, x.Mode(), y.Mode())
		}
	}
	for name, want := range map[string]string{"link": "nested/run", "literal": "../../outside"} {
		got, err := os.Readlink(filepath.Join(f.destination, name))
		if err != nil || got != want {
			t.Fatalf("link %q %v", got, err)
		}
	}
	s, _ := os.Stat(filepath.Join(f.destination, "nested"))
	if s.Mode().Perm() != 0750 {
		t.Fatal(s.Mode())
	}
	s, _ = os.Stat(f.destination)
	if s.Mode().Perm() != 0700 {
		t.Fatal(s.Mode())
	}
}
func TestCanonicalIdentityAndPreparation(t *testing.T) {
	for _, s := range []string{"0", "1", "18446744073709551615"} {
		if !canonical(s) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"", "00", "01", "+1", "-1", " 1", "18446744073709551616", "１"} {
		if canonical(s) {
			t.Fatal(s)
		}
	}
	for _, which := range []string{"identity", "same", "source-mode", "dest-mode", "destination", "nil", "expired"} {
		t.Run(which, func(t *testing.T) {
			f := setup(t)
			a, b := f.a, f.b
			until := time.Now().Add(time.Minute)
			code := "input"
			switch which {
			case "identity":
				a.Identity.Inode = "0"
				code = "identity"
			case "same":
				b = a
			case "source-mode":
				os.Chmod(f.source, 0770)
				code = "mode"
			case "dest-mode":
				os.Chmod(f.destination, 0750)
				code = "mode"
			case "destination":
				put(t, filepath.Join(f.destination, "foreign"), "keep", 0600)
				code = "destination"
			case "nil":
				a.File = nil
			case "expired":
				until = time.Now().Add(-time.Second)
				code = "deadline"
			}
			_, err := Prepare(a, b, until, func(context.Context) error { return nil })
			failure(t, err, code, false, false)
		})
	}
}
func TestSharedOnceAndCapture(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "contents", 0700)
	var fences atomic.Int32
	op := f.prepare(t, func(context.Context) error { fences.Add(1); return nil })
	copyOf := *op
	f.a = Directory{}
	f.b = Directory{} // Caller wrappers are captured by value.
	var wg sync.WaitGroup
	results := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- copyOf.Run(context.Background()) }()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else {
			failure(t, err, "consumed", true, false)
		}
	}
	if success != 1 || fences.Load() != 2 {
		t.Fatalf("success %d fences %d", success, fences.Load())
	}
	failure(t, op.Run(context.Background()), "consumed", true, false)
}
func TestFencesAndCancellation(t *testing.T) {
	for _, phase := range []string{"pre", "pre-known", "post", "post-known", "post-untrusted-code", "post-cancel", "post-deadline", "cancel-pre", "cancel-write", "cancel-final"} {
		t.Run(phase, func(t *testing.T) {
			f := setup(t)
			put(t, filepath.Join(f.source, "a"), "data", 0600)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			sentinel := &os.PathError{Op: "private", Path: "/private/never-leak", Err: unix.EIO}
			known := &Failure{Code: "launch_copy_changed"}
			calls := 0
			op := f.prepare(t, func(context.Context) error {
				calls++
				if phase == "pre" {
					return sentinel
				}
				if phase == "pre-known" {
					return known
				}
				if calls == 2 {
					switch phase {
					case "post":
						return sentinel
					case "post-known":
						return &Failure{Code: "launch_copy_changed"}
					case "post-untrusted-code":
						return &Failure{Code: "/private/never-leak"}
					case "post-cancel":
						return context.Canceled
					case "post-deadline":
						return context.DeadlineExceeded
					case "cancel-final":
						cancel()
					}
				}
				return nil
			})
			h := hooks{}
			if phase == "cancel-pre" {
				cancel()
			}
			if phase == "cancel-write" {
				h.before = func(event string) {
					if event == "write" {
						cancel()
					}
				}
			}
			err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, h)
			switch phase {
			case "pre":
				if err != sentinel {
					t.Fatalf("pre fence changed: %v", err)
				}
			case "pre-known":
				if err != known {
					t.Fatal("pre-effect classified fence error changed")
				}
			case "post":
				x := failure(t, err, "fence", true, true)
				if !errors.Is(x, sentinel) || strings.Contains(x.Error(), "private") {
					t.Fatal(x)
				}
			case "post-known":
				failure(t, err, "changed", true, false)
			case "post-untrusted-code":
				failure(t, err, "fence", true, true)
			case "post-cancel", "cancel-write", "cancel-final":
				failure(t, err, "canceled", true, false)
			case "post-deadline":
				failure(t, err, "deadline", true, false)
			case "cancel-pre":
				failure(t, err, "canceled", false, false)
			}
			failure(t, op.Run(context.Background()), "consumed", true, false)
		})
	}
}
func TestOriginalAndEarlierContextDeadline(t *testing.T) {
	for _, bound := range []string{"original", "context"} {
		t.Run(bound, func(t *testing.T) {
			f := setup(t)
			until := time.Now().Add(time.Minute)
			want := time.Now().Add(100 * time.Millisecond)
			ctx := context.Background()
			if bound == "original" {
				until = want
			} else {
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, want)
				defer cancel()
			}
			op, err := Prepare(f.a, f.b, until, func(ctx context.Context) error {
				got, ok := ctx.Deadline()
				if !ok || !got.Equal(want) {
					t.Errorf("fence deadline %v != %v", got, want)
				}
				<-ctx.Done()
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			failure(t, op.Run(ctx), "deadline", false, false)
		})
	}
}
func TestMutationsRefused(t *testing.T) {
	for _, kind := range []string{"root-mode", "root-gid", "file-mode", "file-size", "file-mtime", "file-gid", "file-uid", "entries", "source-pin", "destination-pin", "replace-source", "replace-destination", "post-file", "post-foreign", "post-root-mode"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			p := filepath.Join(f.source, "a")
			put(t, p, "abcdef", 0600)
			calls := 0
			mutation := func() {
				switch kind {
				case "root-mode":
					os.Chmod(f.source, 0750)
				case "root-gid":
					if os.Geteuid() != 0 {
						t.Skip("chown fixture requires root")
					}
					if err := os.Chown(f.source, -1, 12345); err != nil {
						t.Fatal(err)
					}
				case "file-mode":
					os.Chmod(p, 0700)
				case "file-size":
					put(t, p, "larger file", 0600)
				case "file-mtime":
					os.Chtimes(p, time.Unix(1, 0), time.Unix(2, 0))
				case "file-gid":
					if os.Geteuid() != 0 {
						t.Skip("chown fixture requires root")
					}
					if err := os.Chown(p, -1, 12345); err != nil {
						t.Fatal(err)
					}
				case "file-uid":
					if os.Geteuid() != 0 {
						t.Skip("chown fixture requires root")
					}
					if err := os.Chown(p, 12345, -1); err != nil {
						t.Fatal(err)
					}
				case "entries":
					put(t, filepath.Join(f.source, "new"), "foreign", 0600)
				case "replace-source":
					os.Rename(p, p+"-old")
					put(t, p, "new", 0600)
				case "replace-destination":
					os.Rename(filepath.Join(f.destination, "a"), filepath.Join(f.destination, "old"))
					put(t, filepath.Join(f.destination, "a"), "foreign", 0600)
				case "post-file":
					put(t, p, "changed", 0600)
				case "post-foreign":
					put(t, filepath.Join(f.destination, "foreign"), "keep", 0600)
				case "post-root-mode":
					os.Chmod(f.destination, 0750)
				}
			}
			op := f.prepare(t, func(context.Context) error {
				calls++
				if strings.HasPrefix(kind, "post-") && calls == 2 {
					mutation()
				}
				return nil
			})
			if kind == "source-pin" {
				os.Chmod(f.source, 0750)
			}
			if kind == "destination-pin" {
				os.Chmod(f.destination, 0750)
			}
			triggered := false
			h := hooks{before: func(event string) {
				if strings.HasPrefix(kind, "post-") || kind == "source-pin" || kind == "destination-pin" || triggered {
					return
				}
				if (event == "read" && kind != "replace-destination") || (event == "chmod" && kind == "replace-destination") {
					triggered = true
					mutation()
				}
			}}
			err := op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h)
			wantUnknown := kind != "source-pin" && kind != "destination-pin"
			failure(t, err, "changed", wantUnknown, false)
			if kind == "post-foreign" {
				data, err := os.ReadFile(filepath.Join(f.destination, "foreign"))
				if err != nil || string(data) != "keep" {
					t.Fatal("foreign entry was changed")
				}
			}
		})
	}
}
func TestRejectedObjects(t *testing.T) {
	for _, kind := range []string{"hardlink", "fifo", "socket", "mode", "absolute", "badutf8link", "badutf8name"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			code := "type"
			switch kind {
			case "hardlink":
				put(t, filepath.Join(f.source, "a"), "data", 0600)
				if err := os.Link(filepath.Join(f.source, "a"), filepath.Join(f.source, "b")); err != nil {
					t.Fatal(err)
				}
				code = "file"
			case "fifo":
				if err := unix.Mkfifo(filepath.Join(f.source, "a"), 0600); err != nil {
					t.Fatal(err)
				}
			case "socket":
				// The rejection concerns the socket inode, not its bound name.
				// A Go subtest's path can exceed Darwin's sockaddr_un limit;
				// bind under a short owned sibling, then move that same inode.
				socketRoot, err := os.MkdirTemp("", "fc-")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.RemoveAll(socketRoot) })
				fd, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer unix.Close(fd)
				bound := filepath.Join(socketRoot, "a")
				if err := unix.Bind(fd, &unix.SockaddrUnix{Name: bound}); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(bound, filepath.Join(f.source, "a")); err != nil {
					t.Fatal(err)
				}
				os.Chmod(filepath.Join(f.source, "a"), 0600)
			case "mode":
				put(t, filepath.Join(f.source, "a"), "data", 0660)
				code = "mode"
			case "absolute":
				os.Symlink("/absolute", filepath.Join(f.source, "a"))
				code = "link"
			case "badutf8link":
				os.Symlink(string([]byte{0xff}), filepath.Join(f.source, "a"))
				code = "link"
			case "badutf8name":
				name := filepath.Join(f.source, string([]byte{0xff}))
				if err := os.WriteFile(name, []byte("bad"), 0600); errors.Is(err, unix.EILSEQ) {
					t.Skip("APFS refuses non-UTF-8 names, so this refusal cannot be fixtured here")
				}
				put(t, name, "bad", 0600)
				code = "name"
			}
			op := f.prepare(t, nil)
			failure(t, op.Run(context.Background()), code, false, false)
		})
	}
}
func TestLimits(t *testing.T) {
	for _, kind := range []string{"bytes", "entries", "reserved-siblings", "depth"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			limit := limits{maxEntries, maxDepth, maxBytes}
			unknown := false
			switch kind {
			case "bytes":
				put(t, filepath.Join(f.source, "a"), "12345", 0600)
				limit.bytes = 4
				unknown = true
			case "entries":
				for i := 0; i < 129; i++ {
					put(t, filepath.Join(f.source, fmt.Sprint(i)), "", 0600)
				}
				limit.entries = 128
			case "reserved-siblings":
				os.Mkdir(filepath.Join(f.source, "a"), 0700)
				put(t, filepath.Join(f.source, "a", "nested"), "", 0600)
				put(t, filepath.Join(f.source, "z"), "", 0600)
				limit.entries = 2
				unknown = true
			case "depth":
				os.Mkdir(filepath.Join(f.source, "a"), 0700)
				os.Mkdir(filepath.Join(f.source, "a", "b"), 0700)
				limit.depth = 1
				unknown = true
			}
			op := f.prepare(t, nil)
			failure(t, op.run(context.Background(), limit, hooks{}), "limit", unknown, false)
		})
	}
	for _, raw := range [][]byte{nil, []byte("/a"), []byte("a\x00b"), {0xff}, bytes.Repeat([]byte("a"), 4097)} {
		_, err := linkText(raw)
		if err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	if _, err := linkText(bytes.Repeat([]byte("a"), 4096)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"", ".", "..", "a/b", "a\x00b", string([]byte{0xff})} {
		if component(name) {
			t.Fatal(name)
		}
	}
	for _, name := range []string{"é", "😀", "a\\b", "e\u0301"} {
		if !component(name) {
			t.Fatal(name)
		}
	}
}
func TestPartialWriteAndIOFailures(t *testing.T) {
	for _, kind := range []string{"partial", "zero", "write-error", "partial-error", "fsync-error", "cancel-after-write"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			put(t, filepath.Join(f.source, "a"), "abcdefgh", 0600)
			op := f.prepare(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			h := hooks{}
			switch kind {
			case "partial":
				h.write = func(fd int, p []byte) (int, error) { return unix.Write(fd, p[:1]) }
			case "zero":
				h.write = func(int, []byte) (int, error) { return 0, nil }
			case "write-error":
				h.write = func(int, []byte) (int, error) { return 0, unix.EIO }
			case "partial-error":
				h.write = func(fd int, p []byte) (int, error) { n, _ := unix.Write(fd, p[:1]); return n, unix.EIO }
			case "fsync-error":
				h.fsync = func(int) error { return unix.EIO }
			case "cancel-after-write":
				h.write = func(fd int, p []byte) (int, error) { n, e := unix.Write(fd, p); cancel(); return n, e }
			}
			err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, h)
			switch kind {
			case "partial":
				if err != nil {
					t.Fatal(err)
				}
				b, e := os.ReadFile(filepath.Join(f.destination, "a"))
				if e != nil || string(b) != "abcdefgh" {
					t.Fatal("partial writes lost bytes")
				}
			case "zero":
				failure(t, err, "write", true, false)
			case "cancel-after-write":
				failure(t, err, "canceled", true, false)
			default:
				failure(t, err, "io", true, true)
			}
		})
	}
}

func TestFullModesAndInheritedOwnership(t *testing.T) {
	f := setup(t)
	p := filepath.Join(f.source, "a")
	put(t, p, "inert fixture", 0600)
	if os.Geteuid() == 0 {
		if err := os.Chown(p, -1, 12345); err != nil {
			t.Fatal(err)
		}
	}
	if err := unix.Chmod(p, 04750); err != nil {
		t.Fatal(err)
	}
	op := f.prepare(t, nil)
	if err := op.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	var source, destination unix.Stat_t
	if err := unix.Lstat(p, &source); err != nil {
		t.Fatal(err)
	}
	if err := unix.Lstat(filepath.Join(f.destination, "a"), &destination); err != nil {
		t.Fatal(err)
	}
	if source.Mode != destination.Mode || destination.Uid != uint32(os.Geteuid()) {
		t.Fatal("full mode/owner changed")
	}
	if os.Geteuid() == 0 && destination.Gid == source.Gid {
		t.Fatal("source gid was rewritten onto destination")
	}
}

func TestRestrictiveFileUmask(t *testing.T) {
	// Umask is process-wide: exercise it in a child test process, without
	// reconfiguring the process running the race suite or unrelated tests.
	if os.Getenv("FAROL_INSTALLCOPY_UMASK_TEST") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestRestrictiveFileUmask$")
		command.Env = append(os.Environ(), "FAROL_INSTALLCOPY_UMASK_TEST=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("umask child: %v\n%s", err, output)
		}
		return
	}
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "contents", 0700)
	op := f.prepare(t, nil)
	previous := unix.Umask(0200)
	defer unix.Umask(previous)
	if err := op.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.Stat(filepath.Join(f.destination, "a"))
	if err != nil || got.Mode().Perm() != 0700 {
		t.Fatal("source mode was not restored")
	}
}

func TestOriginalRootPinsAtCopyBoundary(t *testing.T) {
	for _, which := range []string{"source", "destination"} {
		t.Run(which, func(t *testing.T) {
			f := setup(t)
			op := f.prepare(t, nil)
			stats := 0
			h := hooks{before: func(event string) {
				if event != "fstat" {
					return
				}
				stats++
				if stats == 5 {
					p := f.source
					mode := os.FileMode(0750)
					if which == "destination" {
						p = f.destination
						mode = 0500
					}
					if err := os.Chmod(p, mode); err != nil {
						t.Fatal(err)
					}
				}
			}}
			failure(t, op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h), "changed", false, false)
		})
	}
}

func TestRootMetadataMutationDuringSync(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "data", 0600)
	op := f.prepare(t, nil)
	changed := false
	h := hooks{fsync: func(fd int) error {
		var stat unix.Stat_t
		if err := unix.Fstat(fd, &stat); err != nil {
			return err
		}
		if metadata(stat).identity() == f.b.Identity {
			changed = true
			if err := os.Chmod(f.destination, 0750); err != nil {
				return err
			}
		}
		return unix.Fsync(fd)
	}}
	failure(t, op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h), "changed", true, false)
	if !changed {
		t.Fatal("root fsync seam was not exercised")
	}
}

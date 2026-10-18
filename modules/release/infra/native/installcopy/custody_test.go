//go:build linux || darwin

package installcopy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestCollisionPreservesForeignEntries(t *testing.T) {
	for _, kind := range []string{"file", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			switch kind {
			case "file":
				put(t, filepath.Join(f.source, "a"), "source", 0600)
			case "directory":
				if err := os.Mkdir(filepath.Join(f.source, "a"), 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink("source", filepath.Join(f.source, "a")); err != nil {
					t.Fatal(err)
				}
			}
			op := f.prepare(t, nil)
			opens := 0
			inserted := false
			h := hooks{before: func(event string) {
				if event == "open" {
					opens++
				}
				if !inserted && ((kind == "file" && event == "open" && opens == 4) || (kind == "directory" && event == "mkdir") || (kind == "symlink" && event == "symlink")) {
					inserted = true
					put(t, filepath.Join(f.destination, "a"), "foreign", 0600)
				}
			}}
			failure(t, op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h), "collision", false, true)
			b, err := os.ReadFile(filepath.Join(f.destination, "a"))
			if err != nil || string(b) != "foreign" {
				t.Fatal("collision overwrote foreign file")
			}
		})
	}
}

func TestNoFollowRaces(t *testing.T) {
	for _, kind := range []string{"file-symlink", "file-fifo", "directory-symlink"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			p := filepath.Join(f.source, "a")
			if kind == "directory-symlink" {
				if err := os.Mkdir(p, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				put(t, p, "original", 0600)
			}
			outside := filepath.Join(t.TempDir(), "outside")
			put(t, outside, "must-not-be-read", 0600)
			op := f.prepare(t, nil)
			opens := 0
			changed := false
			h := hooks{before: func(event string) {
				if event == "open" {
					opens++
				}
				if !changed && ((kind != "directory-symlink" && event == "open" && opens == 3) || (kind == "directory-symlink" && event == "mkdir")) {
					changed = true
					if err := os.Remove(p); err != nil {
						t.Fatal(err)
					}
					if kind == "file-fifo" {
						if err := unix.Mkfifo(p, 0600); err != nil {
							t.Fatal(err)
						}
					} else {
						if err := os.Symlink(outside, p); err != nil {
							t.Fatal(err)
						}
					}
				}
			}}
			failure(t, op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h), "changed", kind == "directory-symlink", kind != "file-fifo")
			if kind != "directory-symlink" {
				if _, err := os.Lstat(filepath.Join(f.destination, "a")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("created destination before source authentication")
				}
			}
		})
	}
}

func TestBorrowedFlagsOffsetsAndLocks(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "copy", 0600)
	if _, err := f.a.File.Readdirnames(1); err != nil {
		t.Fatal(err)
	}
	type observed struct {
		offset            int64
		flags, descriptor int
	}
	inspect := func(f *os.File, configure bool) (v observed) {
		t.Helper()
		raw, err := f.SyscallConn()
		if err != nil {
			t.Fatal(err)
		}
		var inner error
		if err = raw.Control(func(fd uintptr) {
			if configure {
				_, inner = unix.FcntlInt(fd, unix.F_SETFL, unix.O_NONBLOCK)
				if inner == nil {
					inner = unix.Flock(int(fd), unix.LOCK_EX|unix.LOCK_NB)
				}
			}
			if inner != nil {
				return
			}
			v.flags, inner = unix.FcntlInt(fd, unix.F_GETFL, 0)
			if inner != nil {
				return
			}
			v.descriptor, inner = unix.FcntlInt(fd, unix.F_GETFD, 0)
			if inner != nil {
				return
			}
			v.offset, inner = unix.Seek(int(fd), 0, 1)
		}); err != nil {
			t.Fatal(err)
		}
		if inner != nil {
			t.Fatal(inner)
		}
		return
	}
	a, b := inspect(f.a.File, true), inspect(f.b.File, true)
	op := f.prepare(t, nil)
	if err := op.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := inspect(f.a.File, false); got != a {
		t.Fatalf("source descriptor changed: %#v != %#v", got, a)
	}
	if got := inspect(f.b.File, false); got != b {
		t.Fatalf("destination descriptor changed: %#v != %#v", got, b)
	}
	for _, p := range []string{f.source, f.destination} {
		other, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		err = unix.Flock(int(other.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		other.Close()
		if !errors.Is(err, unix.EWOULDBLOCK) {
			t.Fatalf("borrowed lock lost: %v", err)
		}
	}
}

func TestCustodyUntilActualReturnAfterCancellation(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "bytes", 0600)
	entered, release := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	op := f.prepare(t, nil)
	aFD, bFD := int(f.a.File.Fd()), int(f.b.File.Fd())
	finished := make(chan error, 1)
	go func() {
		finished <- op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, hooks{fsync: func(fd int) error {
			close(entered)
			<-release
			return unix.Fsync(fd)
		}})
	}()
	<-entered
	cancel()
	aClosed, bClosed := make(chan error, 1), make(chan error, 1)
	go func() { aClosed <- f.a.File.Close() }()
	go func() { bClosed <- f.b.File.Close() }()
	select {
	case <-finished:
		t.Fatal("Run abandoned synchronous I/O")
	case <-time.After(20 * time.Millisecond):
	}
	// Close is allowed to return early, but Control must retain the underlying
	// references: the exact numeric descriptors cannot be closed or reused yet.
	for fd, want := range map[int]Identity{aFD: f.a.Identity, bFD: f.b.Identity} {
		var s unix.Stat_t
		if err := unix.Fstat(fd, &s); err != nil || metadata(s).identity() != want {
			close(release)
			t.Fatalf("borrowed physical descriptor lost during I/O: %v", err)
		}
	}
	close(release)
	failure(t, <-finished, "canceled", true, false)
	if err := <-aClosed; err != nil {
		t.Fatal(err)
	}
	if err := <-bClosed; err != nil {
		t.Fatal(err)
	}
}

func TestCloseBorrowedBeforeRunConsumesWithoutEffects(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "data", 0600)
	op := f.prepare(t, nil)
	if err := f.a.File.Close(); err != nil {
		t.Fatal(err)
	}
	failure(t, op.Run(context.Background()), "io", false, true)
	failure(t, op.Run(context.Background()), "consumed", true, false)
	items, err := os.ReadDir(f.destination)
	if err != nil || len(items) != 0 {
		t.Fatal("closed source caused effects")
	}
}

func TestNestedDirectoryCloseErrorIsNotSuccess(t *testing.T) {
	f := setup(t)
	if err := os.Mkdir(filepath.Join(f.source, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	op := f.prepare(t, nil)
	closed := 0
	failure(t, op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, hooks{close: func(fd int) error {
		closed++
		if err := unix.Close(fd); err != nil {
			t.Error(err)
		}
		return unix.EIO
	}}), "io", true, true)
	if closed != 2 {
		t.Fatalf("owned nested handles closed %d times", closed)
	}
	if _, err := f.a.File.Stat(); err != nil {
		t.Fatal("closed borrowed source")
	}
	if _, err := f.b.File.Stat(); err != nil {
		t.Fatal("closed borrowed destination")
	}
}

func TestCreateErrorsRetainUnknownEffects(t *testing.T) {
	for _, known := range []bool{false, true} {
		t.Run(map[bool]string{false: "unexpected-io", true: "known-refusal"}[known], func(t *testing.T) {
			f := setup(t)
			put(t, filepath.Join(f.source, "a"), "data", 0600)
			op := f.prepare(t, nil)
			h := hooks{open: func(parent int, name string, flags int, mode uint32) (int, error) {
				fd, err := unix.Openat(parent, name, flags, mode)
				if err == nil && flags&unix.O_CREAT != 0 {
					if e := unix.Close(fd); e != nil {
						t.Error(e)
					}
					if known {
						return -1, unix.EACCES
					}
					return -1, unix.EIO
				}
				return fd, err
			}}
			err := op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h)
			if known {
				failure(t, err, "mode", true, true)
			} else {
				failure(t, err, "io", true, true)
			}
			if _, err := os.Stat(filepath.Join(f.destination, "a")); err != nil {
				t.Fatal("fault seam did not create its private partial entry")
			}
		})
	}
}

// Cancellation is injected only after the actual Control callback and owned
// child cleanup return, before the public operation's final bound check.
func TestCaptureOuterReturnRetainsPostEffectUncertainty(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled capture Control return")
	}
	root, err := os.MkdirTemp("", "farol-capture-control-return-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED capture Control-return fixture:", root)
	parent := openDirectory(t, root)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var child *os.File
	name := ""
	returned := false
	err = withCapture(ctx, parent, time.Now().Add(time.Minute), func(context.Context) error { return nil }, func(capture string, d Directory) error { name = capture; child = d.File; return nil }, func() {
		returned = true
		if child == nil {
			t.Error("capture never entered")
		} else if _, err := child.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Error("original owned child cleanup not joined", err)
		}
		cancel()
	})
	var f *Failure
	if !returned || name == "" || !errors.As(err, &f) || !f.Uncertain || !errors.Is(err, context.Canceled) {
		t.Fatal("outer post-effect cancellation became ordinary refusal", err)
	}
	if _, err := os.Stat(filepath.Join(root, name)); err != nil {
		t.Fatal("failed capture removed", err)
	}
	if _, err := parent.File.Stat(); err != nil {
		t.Fatal("original borrowed parent closed", err)
	}
}

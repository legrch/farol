//go:build linux || darwin

package helperlocks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type fixture struct {
	path string
	dir  Directory
}

func setup(t *testing.T) fixture {
	t.Helper()
	p := t.TempDir()
	if e := os.Chmod(p, 0700); e != nil {
		t.Fatal(e)
	}
	fd, e := unix.Open(p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	f := os.NewFile(uintptr(fd), "borrowed-parent")
	t.Cleanup(func() {
		if e := f.Close(); e != nil && !errors.Is(e, os.ErrClosed) {
			t.Error(e)
		}
	})
	var s unix.Stat_t
	if e = unix.Fstat(fd, &s); e != nil {
		t.Fatal(e)
	}
	return fixture{p, Directory{f, metadata(s).identity()}}
}
func (f fixture) put(t *testing.T, name string, mode os.FileMode) {
	t.Helper()
	if e := os.WriteFile(filepath.Join(f.path, name), []byte("sentinel"), mode); e != nil {
		t.Fatal(e)
	}
	if e := os.Chmod(filepath.Join(f.path, name), mode); e != nil {
		t.Fatal(e)
	}
}
func (f fixture) acquire(t *testing.T, promotion bool, h hooks) *Lease {
	t.Helper()
	l, e := acquire(context.Background(), f.dir, time.Now().Add(time.Minute), promotion, h)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := l.Close(); e != nil {
			t.Error(e)
		}
	})
	return l
}
func failure(t *testing.T, e error, code string, internal, uncertain bool) *Failure {
	t.Helper()
	f, ok := e.(*Failure)
	if !ok || f == nil || f.Code != code || f.Internal != internal || f.Uncertain != uncertain {
		t.Fatalf("got %#v want %s internal=%v uncertain=%v", e, code, internal, uncertain)
	}
	if !closedCode(e.Error()) || strings.Contains(e.Error(), "/") {
		t.Fatalf("unclosed error %q", e.Error())
	}
	return f
}
func fdOf(t *testing.T, f *os.File) int {
	t.Helper()
	c, e := f.SyscallConn()
	if e != nil {
		t.Fatal(e)
	}
	var fd int
	if e = c.Control(func(n uintptr) { fd = int(n) }); e != nil {
		t.Fatal(e)
	}
	return fd
}
func probe(t *testing.T, f fixture, name string, busy bool) {
	t.Helper()
	fd, e := unix.Open(filepath.Join(f.path, name), fileFlags, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	e = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	if busy {
		if e != unix.EWOULDBLOCK && e != unix.EAGAIN {
			t.Fatalf("independent description did not remain excluded: %v", e)
		}
	} else if e != nil {
		t.Fatalf("owned close did not release: %v", e)
	}
}

func TestUpdateCreateExistingAndLifetimeCopies(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprint(existing), func(t *testing.T) {
			f := setup(t)
			if existing {
				f.put(t, "lock", 0666)
			}
			var syncs, closes atomic.Int32
			l := f.acquire(t, false, hooks{fsync: func(fd int) error { syncs.Add(1); return unix.Fsync(fd) }, close: func(f *os.File) error { closes.Add(1); return f.Close() }})
			if got := syncs.Load(); got != map[bool]int32{false: 1, true: 0}[existing] {
				t.Fatal("wrong create fsync sequence")
			}
			if e := l.Verify(context.Background()); e != nil {
				t.Fatal(e)
			}
			for range 2 {
				if e := l.WithFile(context.Background(), func(file *os.File, i Identity) error {
					if l.owner.file != file {
						t.Fatal("different authoritative file")
					}
					var s unix.Stat_t
					if e := unix.Fstat(fdOf(t, file), &s); e != nil {
						return e
					}
					if metadata(s).identity() != i {
						t.Fatal("wrong borrowed identity")
					}
					return nil
				}); e != nil {
					t.Fatal(e)
				}
			}
			probe(t, f, "lock", true)
			copy := *l
			var wg sync.WaitGroup
			for range 16 {
				wg.Go(func() {
					if e := copy.Close(); e != nil {
						t.Error(e)
					}
				})
			}
			wg.Wait()
			if closes.Load() != 1 {
				t.Fatal("owned description closed more than once")
			}
			probe(t, f, "lock", false)
			failure(t, l.Verify(context.Background()), "lock_closed", false, false)
			s, e := os.Stat(filepath.Join(f.path, "lock"))
			if e != nil {
				t.Fatal(e)
			}
			if existing && s.Mode().Perm() != 0666 {
				t.Fatal("update existing mode changed")
			}
		})
	}
}

func TestPromotionMustExistAndRemainPrivate(t *testing.T) {
	f := setup(t)
	l, e := AcquirePromotion(context.Background(), f.dir, time.Now().Add(time.Minute))
	if l != nil {
		t.Fatal("missing file granted lease")
	}
	failure(t, e, "owner_lease_type", false, false)
	if _, e = os.Lstat(filepath.Join(f.path, "promotion.lease")); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("promotion was created")
	}
	f.put(t, "promotion.lease", 0640)
	_, e = AcquirePromotion(context.Background(), f.dir, time.Now().Add(time.Minute))
	failure(t, e, "owner_lease_type", false, false)
	if e = os.Chmod(filepath.Join(f.path, "promotion.lease"), 0600); e != nil {
		t.Fatal(e)
	}
	l = f.acquire(t, true, hooks{})
	probe(t, f, "promotion.lease", true)
	_, e = AcquirePromotion(context.Background(), f.dir, time.Now().Add(time.Minute))
	failure(t, e, "owner_lease_held", false, false)
	if !errors.Is(e, unix.EWOULDBLOCK) {
		t.Fatal("busy cause lost")
	}
	probe(t, f, "promotion.lease", true)
	if e = l.Close(); e != nil {
		t.Fatal(e)
	}
	probe(t, f, "promotion.lease", false)
}

func TestBorrowedParentFlagsOffsetsAndLocksUnchanged(t *testing.T) {
	f := setup(t)
	fd := fdOf(t, f.dir.File)
	flags, e := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if e != nil {
		t.Fatal(e)
	}
	if flags&unix.O_ACCMODE != unix.O_RDONLY {
		t.Fatal("fixture must exercise a real read-only borrowed directory description")
	}
	fdflags, e := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if e != nil {
		t.Fatal(e)
	}
	offset, seekErr := unix.Seek(fd, 0, unix.SEEK_CUR)
	parentLocked := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB) == nil
	// Darwin reports a sticky FHASLOCK status bit once a description has been
	// flocked, so the baseline must include the fixture's own lock.
	if flags, e = unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0); e != nil {
		t.Fatal(e)
	}
	l := f.acquire(t, false, hooks{})
	if e = l.Verify(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e = l.Close(); e != nil {
		t.Fatal(e)
	}
	got, e := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if e != nil || got != flags {
		t.Fatal("parent flags changed")
	}
	got, e = unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if e != nil || got != fdflags {
		t.Fatal("parent inheritability changed")
	}
	if seekErr == nil {
		got, e := unix.Seek(fd, 0, unix.SEEK_CUR)
		if e != nil || got != offset {
			t.Fatal("parent offset changed")
		}
	}
	if parentLocked {
		other, e := unix.Open(f.path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if e != nil {
			t.Fatal(e)
		}
		defer unix.Close(other)
		e = unix.Flock(other, unix.LOCK_EX|unix.LOCK_NB)
		if e != unix.EWOULDBLOCK && e != unix.EAGAIN {
			t.Fatal("borrowed parent lock released")
		}
	}
}

func TestInspectedTypesAndParentModes(t *testing.T) {
	for _, promotion := range []bool{false, true} {
		for _, kind := range []string{"symlink", "hardlink", "directory"} {
			t.Run(fmt.Sprintf("%v/%s", promotion, kind), func(t *testing.T) {
				f := setup(t)
				name := "lock"
				code := "lock_type"
				if promotion {
					name = "promotion.lease"
					code = "owner_lease_type"
				}
				f.put(t, "other", 0600)
				var e error
				switch kind {
				case "symlink":
					e = os.Symlink("other", filepath.Join(f.path, name))
				case "hardlink":
					e = os.Link(filepath.Join(f.path, "other"), filepath.Join(f.path, name))
				case "directory":
					e = os.Mkdir(filepath.Join(f.path, name), 0700)
				}
				if e != nil {
					t.Fatal(e)
				}
				_, e = acquire(context.Background(), f.dir, time.Now().Add(time.Minute), promotion, hooks{})
				failure(t, e, code, false, false)
			})
		}
	}
	for _, tc := range []struct {
		mode               os.FileMode
		promotion, allowed bool
	}{{0755, false, true}, {0755, true, false}, {0770, false, false}, {0700, true, true}} {
		t.Run(fmt.Sprintf("%o/%v", tc.mode, tc.promotion), func(t *testing.T) {
			f := setup(t)
			f.put(t, "promotion.lease", 0600)
			if e := os.Chmod(f.path, tc.mode); e != nil {
				t.Fatal(e)
			}
			l, e := acquire(context.Background(), f.dir, time.Now().Add(time.Minute), tc.promotion, hooks{})
			if tc.allowed {
				if e != nil {
					t.Fatal(e)
				}
				if e = l.Close(); e != nil {
					t.Fatal(e)
				}
			} else {
				failure(t, e, "lock_parent_type", false, false)
			}
		})
	}
}

func TestReplacedNamedHeldMetadataAndParentChanges(t *testing.T) {
	for _, change := range []string{"replace", "mode", "hardlink", "parent-mode", "parent-identity"} {
		t.Run(change, func(t *testing.T) {
			f := setup(t)
			l := f.acquire(t, false, hooks{})
			var e error
			switch change {
			case "replace":
				e = os.Rename(filepath.Join(f.path, "lock"), filepath.Join(f.path, "old"))
				if e == nil {
					f.put(t, "lock", 0600)
				}
			case "mode":
				e = os.Chmod(filepath.Join(f.path, "lock"), 0644)
			case "hardlink":
				e = os.Link(filepath.Join(f.path, "lock"), filepath.Join(f.path, "alias"))
			case "parent-mode":
				e = os.Chmod(f.path, 0755)
			case "parent-identity":
				l.owner.parent.Identity.Inode = "0" // malformed caller binding fixture, not a physical route observation
			}
			if e != nil {
				t.Fatal(e)
			}
			code := "lock_replaced"
			if change == "parent-mode" {
				code = "lock_parent_changed"
			}
			if change == "parent-identity" {
				code = "lock_parent_type"
			}
			failure(t, l.Verify(context.Background()), code, false, false)
		})
	}
}

func TestCrossedDescriptionNeverRepairsOriginalLease(t *testing.T) {
	f := setup(t)
	f.put(t, "promotion.lease", 0600)
	fd, e := unix.Open(filepath.Join(f.path, "promotion.lease"), fileFlags, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer unix.Close(fd)
	if e = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); e != nil {
		t.Fatal(e)
	}
	_, e = AcquirePromotion(context.Background(), f.dir, time.Now().Add(time.Minute))
	failure(t, e, "owner_lease_held", false, false)
	probe(t, f, "promotion.lease", true)
	if e = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); e != nil {
		t.Fatal("original description changed")
	}
}

func TestWithFilePostCheckAndErrorClassification(t *testing.T) {
	opaque := &os.PathError{Op: "private", Path: "/never/leak", Err: unix.EIO}
	var typedNil *Failure
	for _, tc := range []struct {
		name     string
		cause    error
		internal bool
		code     string
	}{
		{"cancel", context.Canceled, false, "lock_canceled"}, {"deadline", context.DeadlineExceeded, false, "lock_deadline"},
		{"joined", errors.Join(context.Canceled, opaque), true, "lock_callback"}, {"wrapped", fmt.Errorf("secret: %w", context.Canceled), true, "lock_callback"},
		{"internal-context", &Failure{Code: "lock_io", Internal: true, cause: context.Canceled}, true, "lock_callback"},
		{"typed-nil", typedNil, true, "lock_callback"}, {"malformed", &Failure{Code: "/never/leak"}, true, "lock_callback"}, {"malformed-native", &Failure{Code: "lock_io"}, true, "lock_callback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t)
			l := f.acquire(t, false, hooks{})
			e := l.WithFile(context.Background(), func(*os.File, Identity) error { return tc.cause })
			failure(t, e, tc.code, tc.internal, false)
			if !errors.Is(e, tc.cause) {
				t.Fatal("callback cause lost")
			}
			if e = l.Verify(context.Background()); e != nil {
				t.Fatal(e)
			}
		})
	}
	f := setup(t)
	l := f.acquire(t, false, hooks{})
	callback := errors.New("opaque callback refusal")
	e := l.WithFile(context.Background(), func(*os.File, Identity) error {
		if e := os.Chmod(filepath.Join(f.path, "lock"), 0644); e != nil {
			t.Fatal(e)
		}
		return callback
	})
	failure(t, e, "lock_callback", true, false)
	if !errors.Is(e, callback) || !containsCode(e, "lock_replaced") {
		t.Fatal("callback or post-verification failure lost")
	}
}

func containsCode(e error, code string) bool {
	if e == nil {
		return false
	}
	if f, ok := e.(*Failure); ok && f != nil && f.Code == code {
		return true
	}
	if m, ok := e.(interface{ Unwrap() []error }); ok {
		for _, x := range m.Unwrap() {
			if containsCode(x, code) {
				return true
			}
		}
		return false
	}
	return containsCode(errors.Unwrap(e), code)
}

func TestInvalidInputsAndUint64CanonicalIdentity(t *testing.T) {
	f := setup(t)
	for _, s := range []string{"", "01", "-1", "+1", "18446744073709551616", "1.0", " 1"} {
		d := f.dir
		d.Identity.Inode = s
		_, e := AcquireUpdate(context.Background(), d, time.Now().Add(time.Minute))
		failure(t, e, "lock_input", false, false)
	}
	if !canonical("18446744073709551615") || !canonical("0") {
		t.Fatal("valid uint64 rejected")
	}
	_, e := AcquireUpdate(nil, f.dir, time.Now().Add(time.Minute))
	failure(t, e, "lock_input", false, false)
	_, e = AcquireUpdate(context.Background(), f.dir, time.Time{})
	failure(t, e, "lock_input", false, false)
	var l *Lease
	failure(t, l.Verify(context.Background()), "lock_input", false, false)
	failure(t, l.Close(), "lock_input", false, false)
	closed := setup(t)
	if e = closed.dir.File.Close(); e != nil {
		t.Fatal(e)
	}
	_, e = AcquireUpdate(context.Background(), closed.dir, time.Now().Add(time.Minute))
	failure(t, e, "lock_io", true, false)
}

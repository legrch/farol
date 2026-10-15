//go:build linux || darwin

package helperlocks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestEveryNativeErrorKeepsExactCauseWithCancellation(t *testing.T) {
	for _, where := range []string{"held", "named", "open", "fsync", "flock"} {
		for _, errno := range []error{unix.EACCES, unix.EIO, unix.ENOENT, unix.ELOOP, unix.EINTR} {
			t.Run(where+"/"+errno.Error(), func(t *testing.T) {
				f := setup(t)
				if where != "fsync" {
					f.put(t, "lock", 0600)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				original := &os.PathError{Op: "private", Path: "/never/leak/native", Err: errno}
				h := hooks{}
				var closes atomic.Int32
				h.close = func(f *os.File) error { closes.Add(1); return f.Close() }
				switch where {
				case "held":
					h.held = func(int, *unix.Stat_t) error { cancel(); return original }
				case "named":
					h.named = func(int, string, *unix.Stat_t, int) error { cancel(); return original }
				case "open":
					h.open = func(int, string, int, uint32) (int, error) { cancel(); return -1, original }
				case "fsync":
					h.fsync = func(int) error { cancel(); return original }
				case "flock":
					h.flock = func(int, int) error { cancel(); return original }
				}
				l, e := acquire(ctx, f.dir, time.Now().Add(time.Minute), false, h)
				if l != nil {
					t.Fatal("error returned usable lease")
				}
				failure(t, e, "lock_io", true, where == "fsync")
				if !errors.Is(e, original) || !errors.Is(e, errno) || !errors.Is(e, context.Canceled) {
					t.Fatal("native or cancellation cause disappeared")
				}
				want := int32(0)
				if where == "fsync" || where == "flock" {
					want = 1
				}
				if closes.Load() != want {
					t.Fatal("incorrect owned cleanup count")
				}
			})
		}
	}
}

func TestPartialCreateErrorNeverDeletesOrRetries(t *testing.T) {
	for _, returnFD := range []bool{false, true} {
		t.Run(fmt.Sprint(returnFD), func(t *testing.T) {
			f := setup(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var opens, closes atomic.Int32
			h := hooks{open: func(parent int, name string, flags int, mode uint32) (int, error) {
				opens.Add(1)
				if name != "lock" || flags != fileFlags|unix.O_CREAT|unix.O_EXCL || mode != 0600 {
					t.Fatal("create contract drift")
				}
				fd, e := unix.Openat(parent, name, flags, mode)
				if e != nil {
					t.Fatal(e)
				}
				cancel()
				if returnFD {
					return fd, unix.EIO
				}
				if e = unix.Close(fd); e != nil {
					t.Fatal(e)
				}
				return -1, unix.EIO
			}, close: func(f *os.File) error { closes.Add(1); return f.Close() }}
			l, e := acquire(ctx, f.dir, time.Now().Add(time.Minute), false, h)
			if l != nil {
				t.Fatal("partial create returned lease")
			}
			failure(t, e, "lock_io", true, true)
			if !errors.Is(e, unix.EIO) || !errors.Is(e, context.Canceled) {
				t.Fatal("partial create causes lost")
			}
			if opens.Load() != 1 || closes.Load() != map[bool]int32{false: 0, true: 1}[returnFD] {
				t.Fatal("retried create/close")
			}
			if _, e = os.Lstat(filepath.Join(f.path, "lock")); e != nil {
				t.Fatal("private effect removed")
			}
		})
	}
}

func TestExclusiveCollisionProofIsExactAndDoesNotFollow(t *testing.T) {
	for _, kind := range []string{"exclusive", "wrapped", "symlink", "replaced-existing"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			f.put(t, "other", 0600)
			if kind == "replaced-existing" {
				f.put(t, "lock", 0600)
			}
			var opens atomic.Int32
			h := hooks{open: func(parent int, name string, flags int, mode uint32) (int, error) {
				opens.Add(1)
				if kind == "wrapped" {
					return -1, fmt.Errorf("opaque: %w", unix.EEXIST)
				}
				if kind == "exclusive" {
					f.put(t, "lock", 0600)
				} else {
					if kind == "replaced-existing" {
						if e := os.Remove(filepath.Join(f.path, "lock")); e != nil {
							t.Fatal(e)
						}
					}
					if e := os.Symlink("other", filepath.Join(f.path, "lock")); e != nil {
						t.Fatal(e)
					}
				}
				return unix.Openat(parent, name, flags, mode)
			}}
			_, e := acquire(context.Background(), f.dir, time.Now().Add(time.Minute), false, h)
			failure(t, e, "lock_io", true, kind == "wrapped")
			if opens.Load() != 1 {
				t.Fatal("open retried")
			}
			want := error(unix.EEXIST)
			if kind == "replaced-existing" {
				want = unix.ELOOP
			}
			if !errors.Is(e, want) {
				t.Fatal("collision errno lost")
			}
			data, e := os.ReadFile(filepath.Join(f.path, "other"))
			if e != nil || string(data) != "sentinel" {
				t.Fatal("followed or modified symlink target")
			}
		})
	}
	// This runner fixture isolates accumulation: a later exclusive no-create
	// result cannot erase uncertainty from an earlier private effect.
	r := runner{ctx: context.Background(), until: time.Now().Add(time.Minute), effected: true}
	failure(t, r.result(native(unix.EEXIST)), "lock_io", true, true)
}

func TestBusyCleanupOutcomeAndAllCausesRetained(t *testing.T) {
	for _, promotion := range []bool{false, true} {
		t.Run(fmt.Sprint(promotion), func(t *testing.T) {
			f := setup(t)
			name := "lock"
			code := "update_busy"
			if promotion {
				name = "promotion.lease"
				code = "owner_lease_held"
			}
			f.put(t, name, 0600)
			fd, e := unix.Open(filepath.Join(f.path, name), fileFlags, 0)
			if e != nil {
				t.Fatal(e)
			}
			defer unix.Close(fd)
			if e = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var closes atomic.Int32
			_, e = acquire(ctx, f.dir, time.Now().Add(time.Minute), promotion, hooks{close: func(f *os.File) error {
				closes.Add(1)
				if e := f.Close(); e != nil {
					t.Fatal(e)
				}
				cancel()
				return unix.EIO
			}})
			failure(t, e, "lock_cleanup", true, true)
			if !containsCode(e, code) || !errors.Is(e, unix.EWOULDBLOCK) || !errors.Is(e, unix.EIO) || !errors.Is(e, context.Canceled) {
				t.Fatal("busy/cleanup/cancellation cause lost")
			}
			if closes.Load() != 1 {
				t.Fatal("cleanup retried")
			}
			probe(t, f, name, true)
		})
	}
}

func TestCloseErrorRetainedAcrossCopies(t *testing.T) {
	f := setup(t)
	var closes atomic.Int32
	l, e := acquire(context.Background(), f.dir, time.Now().Add(time.Minute), false, hooks{close: func(f *os.File) error {
		closes.Add(1)
		if e := f.Close(); e != nil {
			t.Fatal(e)
		}
		return unix.EINTR
	}})
	if e != nil {
		t.Fatal(e)
	}
	copy := *l
	first := l.Close()
	failure(t, first, "lock_cleanup", true, true)
	if next := copy.Close(); next != first || !errors.Is(next, unix.EINTR) {
		t.Fatal("close outcome not retained")
	}
	if closes.Load() != 1 {
		t.Fatal("close retried")
	}
	probe(t, f, "lock", false)
}

func TestReplacementsAroundOpenAndFlock(t *testing.T) {
	for _, where := range []string{"open", "flock"} {
		t.Run(where, func(t *testing.T) {
			f := setup(t)
			f.put(t, "lock", 0600)
			var closes atomic.Int32
			replace := func() {
				if e := os.Rename(filepath.Join(f.path, "lock"), filepath.Join(f.path, "old")); e != nil {
					t.Fatal(e)
				}
				f.put(t, "lock", 0600)
			}
			h := hooks{close: func(f *os.File) error { closes.Add(1); return f.Close() }}
			if where == "open" {
				h.open = func(p int, n string, flags int, m uint32) (int, error) { replace(); return unix.Openat(p, n, flags, m) }
			} else {
				h.flock = func(fd, flags int) error { e := unix.Flock(fd, flags); replace(); return e }
			}
			_, e := acquire(context.Background(), f.dir, time.Now().Add(time.Minute), false, h)
			failure(t, e, "lock_replaced", false, false)
			if closes.Load() != 1 {
				t.Fatal("changed description not cleaned")
			}
			probe(t, f, "old", false)
			probe(t, f, "lock", false)
		})
	}
}

func TestPrivilegedOwnerAndGroupMetadataChanges(t *testing.T) {
	for _, field := range []string{"file-uid", "file-gid", "parent-uid", "parent-gid"} {
		t.Run(field, func(t *testing.T) {
			f := setup(t)
			l := f.acquire(t, false, hooks{})
			p := filepath.Join(f.path, "lock")
			if field == "parent-uid" || field == "parent-gid" {
				p = f.path
			}
			var raw unix.Stat_t
			if e := unix.Stat(p, &raw); e != nil {
				t.Fatal(e)
			}
			uid, gid := int(raw.Uid), int(raw.Gid)
			if field == "file-uid" || field == "parent-uid" {
				uid = (uid + 1) % 65535
			} else {
				gid = (gid + 1) % 65535
			}
			if e := os.Chown(p, uid, gid); e != nil {
				t.Skipf("real chown unavailable: %v", e)
			}
			defer func() {
				if e := os.Chown(p, int(raw.Uid), int(raw.Gid)); e != nil {
					t.Error(e)
				}
			}()
			code := "lock_replaced"
			if field == "parent-uid" {
				code = "lock_parent_type"
			}
			if field == "parent-gid" {
				code = "lock_parent_changed"
			}
			failure(t, l.Verify(context.Background()), code, false, false)
		})
	}
}

// These fixtures alter only syscall result metadata. They cover comparison
// predicates when real chown is unavailable; they are not native chown evidence.
func TestSyntheticUIDGIDMetadataFixtures(t *testing.T) {
	for _, field := range []string{"file-uid", "file-gid", "parent-uid", "parent-gid"} {
		t.Run(field, func(t *testing.T) {
			f := setup(t)
			var changed atomic.Bool
			mutate := func(s *unix.Stat_t) {
				if !changed.Load() {
					return
				}
				dir := uint32(s.Mode)&unix.S_IFMT == unix.S_IFDIR
				if (field == "parent-uid" || field == "parent-gid") != dir {
					return
				}
				if field == "file-uid" || field == "parent-uid" {
					s.Uid++
				} else {
					s.Gid++
				}
			}
			l := f.acquire(t, false, hooks{
				held: func(fd int, s *unix.Stat_t) error {
					e := unix.Fstat(fd, s)
					if e == nil {
						mutate(s)
					}
					return e
				},
				named: func(fd int, name string, s *unix.Stat_t, flags int) error {
					e := unix.Fstatat(fd, name, s, flags)
					if e == nil {
						mutate(s)
					}
					return e
				},
			})
			if e := l.Verify(context.Background()); e != nil {
				t.Fatal(e)
			}
			changed.Store(true)
			code := "lock_replaced"
			if field == "parent-uid" {
				code = "lock_parent_type"
			}
			if field == "parent-gid" {
				code = "lock_parent_changed"
			}
			failure(t, l.Verify(context.Background()), code, false, false)
		})
	}
}

func TestMissingAfterAcquisitionIsExactNativeFailure(t *testing.T) {
	f := setup(t)
	l := f.acquire(t, false, hooks{})
	if e := os.Remove(filepath.Join(f.path, "lock")); e != nil {
		t.Fatal(e)
	}
	e := l.Verify(context.Background())
	failure(t, e, "lock_io", true, false)
	if !errors.Is(e, unix.ENOENT) {
		t.Fatal("post-acquisition missing errno lost")
	}
}

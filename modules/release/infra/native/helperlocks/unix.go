//go:build linux || darwin

package helperlocks

import (
	"context"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

const fileFlags = unix.O_RDWR | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK

type fingerprint struct {
	device, inode  uint64
	mode, uid, gid uint32
	links          uint64
}

func (p fingerprint) identity() Identity {
	return Identity{strconv.FormatUint(p.device, 10), strconv.FormatUint(p.inode, 10)}
}
func (p fingerprint) safeParent(private bool) bool {
	return p.mode&unix.S_IFMT == unix.S_IFDIR && p.uid == uint32(os.Geteuid()) && p.mode&0022 == 0 && (!private || p.mode&0077 == 0)
}
func (p fingerprint) safeFile(private bool) bool {
	return p.mode&unix.S_IFMT == unix.S_IFREG && p.uid == uint32(os.Geteuid()) && p.links == 1 && (!private || p.mode&0077 == 0)
}
func (p fingerprint) sameParent(q fingerprint) bool {
	return p.device == q.device && p.inode == q.inode && p.mode == q.mode && p.uid == q.uid && p.gid == q.gid
}

// Private fault seams retain the exact production syscall names, flags and
// ordering. Exported entry points always install real native operations.
type hooks struct {
	held  func(int, *unix.Stat_t) error
	named func(int, string, *unix.Stat_t, int) error
	open  func(int, string, int, uint32) (int, error)
	fsync func(int) error
	flock func(int, int) error
	close func(*os.File) error
}

func (r *runner) call(fn func() error) error {
	if e := r.check(); e != nil {
		return e
	}
	e := fn()
	return combine(native(e), r.check())
}
func (r *runner) control(file *os.File, fn func(int) error) error {
	if e := r.check(); e != nil {
		return e
	}
	c, e := file.SyscallConn()
	if e != nil {
		return combine(native(e), r.check())
	}
	if e = r.check(); e != nil {
		return e
	}
	var inner error
	e = c.Control(func(fd uintptr) { inner = fn(int(fd)) })
	return combine(inner, native(e), r.check())
}
func (r *runner) held(fd int) (fingerprint, error) {
	var s unix.Stat_t
	e := r.call(func() error {
		if h := r.o.hooks.held; h != nil {
			return h(fd, &s)
		}
		return unix.Fstat(fd, &s)
	})
	return metadata(s), e
}
func (r *runner) named(fd int, initial bool) (fingerprint, bool, error) {
	var s unix.Stat_t
	exists := true
	e := r.call(func() error {
		var e error
		if h := r.o.hooks.named; h != nil {
			e = h(fd, r.o.name(), &s, unix.AT_SYMLINK_NOFOLLOW)
		} else {
			e = unix.Fstatat(fd, r.o.name(), &s, unix.AT_SYMLINK_NOFOLLOW)
		}
		// The original entry() existence inspection permits an absent update
		// lock and classifies absent promotion as a type refusal. Later missing
		// entries remain exact native errors; no open/create is retried.
		if initial && e == unix.ENOENT {
			exists = false
			return nil
		}
		return e
	})
	return metadata(s), exists, e
}
func (o *owner) closeFile() error {
	if h := o.hooks.close; h != nil {
		return h(o.file)
	}
	return o.file.Close()
}
func (r *runner) parent(fd int, initial bool) error {
	p, e := r.held(fd)
	if e != nil {
		return e
	}
	if !p.safeParent(r.o.promotion) || p.identity() != r.o.parent.Identity {
		return refusal("lock_parent_type")
	}
	if initial {
		r.o.parentPin = p
	} else if !p.sameParent(r.o.parentPin) {
		return refusal("lock_parent_changed")
	}
	return nil
}
func (r *runner) pair(parent, held int, want fingerprint) error {
	n, _, e := r.named(parent, false)
	if e != nil {
		return e
	}
	h, e := r.held(held)
	if e != nil {
		return e
	}
	if !n.safeFile(r.o.promotion) || !h.safeFile(r.o.promotion) || n != want || h != want {
		return refusal(r.o.code("lock_replaced", "owner_lease_replaced"))
	}
	return nil
}
func (r *runner) verify() error {
	return r.control(r.o.parent.File, func(p int) error {
		if e := r.parent(p, false); e != nil {
			return e
		}
		return r.control(r.o.file, func(f int) error {
			if e := r.pair(p, f, r.o.filePin); e != nil {
				return e
			}
			if e := r.parent(p, false); e != nil {
				return e
			}
			return r.check()
		})
	})
}

func acquire(ctx context.Context, d Directory, until time.Time, promotion bool, h hooks) (lease *Lease, err error) {
	if ctx == nil || !valid(d) || until.IsZero() {
		return nil, refusal("lock_input")
	}
	o := &owner{parent: d, promotion: promotion, until: bound(ctx, until), hooks: h, gate: make(chan struct{}, 1)}
	r := &runner{ctx: ctx, until: o.until, o: o}
	// Cleanup always runs after the actual control/native return. A failed
	// close cannot be retried: descriptor numbers may already have been reused.
	defer func() {
		err = r.result(err)
		if err != nil && o.file != nil {
			if e := o.closeFile(); e != nil {
				err = combine(err, &Failure{Code: "lock_cleanup", Internal: true, Uncertain: true, cause: e})
			}
			err = r.result(err)
		}
		if err != nil {
			lease = nil
		}
	}()
	if err = r.check(); err != nil {
		return nil, err
	}
	err = r.control(d.File, func(parent int) error {
		if e := r.parent(parent, true); e != nil {
			return e
		}
		before, exists, e := r.named(parent, true)
		if e != nil {
			return e
		}
		if !exists && promotion || exists && !before.safeFile(promotion) {
			return refusal(o.code("lock_type", "owner_lease_type"))
		}
		flags := fileFlags
		if !exists {
			flags |= unix.O_CREAT | unix.O_EXCL
		}
		if e = r.check(); e != nil {
			return e
		}
		fd := -1
		var opened error
		// A create attempt may have mutated private state before an error. Only
		// the exact exclusive EEXIST kernel result proves this call no-create.
		prior := r.effected
		if !exists {
			r.effected = true
		}
		if h.open != nil {
			fd, opened = h.open(parent, o.name(), flags, 0600)
		} else {
			fd, opened = unix.Openat(parent, o.name(), flags, 0600)
		}
		if !exists && opened == unix.EEXIST && fd < 0 {
			r.effected = prior
		}
		if fd >= 0 {
			o.file = os.NewFile(uintptr(fd), o.name())
		}
		if e = combine(native(opened), r.check()); e != nil {
			return e
		}
		if o.file == nil {
			return native(unix.EBADF)
		}
		if !exists {
			// Match the helper's create, parent fsync, then flock sequence.
			if e = r.call(func() error {
				if h.fsync != nil {
					return h.fsync(parent)
				}
				return unix.Fsync(parent)
			}); e != nil {
				return e
			}
		}
		return r.control(o.file, func(file int) error {
			pin, e := r.held(file)
			if e != nil {
				return e
			}
			if !pin.safeFile(promotion) {
				return refusal(o.code("lock_type", "owner_lease_type"))
			}
			if exists && pin != before {
				return refusal(o.code("lock_replaced", "owner_lease_replaced"))
			}
			if e = r.pair(parent, file, pin); e != nil {
				return e
			}
			if e = r.parent(parent, false); e != nil {
				return e
			}
			if e = r.check(); e != nil {
				return e
			}
			var locked error
			if h.flock != nil {
				locked = h.flock(file, unix.LOCK_EX|unix.LOCK_NB)
			} else {
				locked = unix.Flock(file, unix.LOCK_EX|unix.LOCK_NB)
			}
			var failure error
			if locked == unix.EWOULDBLOCK || locked == unix.EAGAIN {
				failure = &Failure{Code: o.code("update_busy", "owner_lease_held"), cause: locked}
			} else {
				failure = native(locked)
			}
			if e = combine(failure, r.check()); e != nil {
				return e
			}
			if e = r.pair(parent, file, pin); e != nil {
				return e
			}
			if e = r.parent(parent, false); e != nil {
				return e
			}
			o.filePin = pin
			return r.check()
		})
	})
	if err != nil {
		return nil, err
	}
	if err = r.check(); err != nil {
		return nil, err
	}
	return &Lease{owner: o}, nil
}

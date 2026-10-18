package access

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// ClosedInspection is a read-only projection, never an authority restoration.
// The normal Store.Open durability barrier still applies on the next startup.
type ClosedInspection struct {
	Binding Binding
	Digest  [32]byte
	Status  Status
}

// WithClosedInspection acquires only the existing lock and reads the canonical
// selected snapshot. It creates or syncs nothing and retains the lock through a
// synchronous visitor and full byte/identity recheck. The caller's exact profile
// qualification and independently selected digest remain required prerequisites.
func WithClosedInspection(ctx context.Context, root string, binding Binding, expected [32]byte, visit func(ClosedInspection) error) error {
	return withClosedInspection(ctx, root, binding, expected, visit, nativeCleanup{})
}

func withClosedInspection(ctx context.Context, root string, binding Binding, expected [32]byte, visit func(ClosedInspection) error, cleanup nativeCleanup) (err error) {
	if ctx == nil || !validBinding(binding) || !absolute(root) || expected == ([32]byte{}) || visit == nil {
		return unavailable()
	}
	if ctx.Err() != nil {
		return refuse(ctx.Err())
	}
	canonical, e := filepath.EvalSymlinks(root)
	if e != nil || canonical != root {
		return refuse(e)
	}
	d := &disk{root: root, dir: -1, lock: -1, cleanup: cleanup}
	defer func() {
		if closed := d.close(); closed != nil {
			err = refuse(err, closed)
		}
	}()
	d.dir, e = unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return refuse(e)
	}
	d.identity, e = fdstat(d.dir)
	if e != nil || !private(d.identity, unix.S_IFDIR, 0700) {
		return refuse(e)
	}
	d.lock, e = unix.Openat(d.dir, lockName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return refuse(e)
	}
	d.lockIdentity, e = fdstat(d.lock)
	if e != nil || !private(d.lockIdentity, unix.S_IFREG, 0600) || d.lockIdentity.Size != 0 {
		return refuse(e)
	}
	if e = unix.Flock(d.lock, unix.LOCK_EX|unix.LOCK_NB); e != nil {
		return refuse(e)
	}
	if e = d.check(); e != nil {
		return e
	}
	var named unix.Stat_t
	if e = unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil {
		return refuse(e)
	}
	raw, e := d.read()
	if e != nil || sha256.Sum256(raw) != expected {
		return refuse(e)
	}
	state, e := decodeState(binding, raw)
	if e != nil {
		return e
	}
	recheck := func() error {
		if ctx.Err() != nil {
			return refuse(ctx.Err())
		}
		if e := d.check(); e != nil {
			return e
		}
		current, e := d.read()
		rootNow, re := fdstat(d.dir)
		lockNow, le := fdstat(d.lock)
		var currentNamed unix.Stat_t
		if e != nil || re != nil || le != nil || !bytes.Equal(raw, current) || !stableState(d.identity, rootNow) || !stableState(d.lockIdentity, lockNow) {
			return refuse(e, re, le)
		}
		if e = unix.Fstatat(d.dir, stateName, &currentNamed, unix.AT_SYMLINK_NOFOLLOW); e != nil || !stableState(named, currentNamed) {
			return refuse(e)
		}
		return nil
	}
	if e = recheck(); e != nil {
		return e
	}
	callback := visit(ClosedInspection{Binding: binding, Digest: expected, Status: Status{Revision: state.Revision, Generation: state.Generation, ApprovalPresent: state.Approval != nil}})
	if e = recheck(); e != nil {
		return refuse(callback, e)
	}
	if callback != nil {
		return &inspectionCallbackFailure{cause: callback}
	}
	return nil
}

type inspectionCallbackFailure struct{ cause error }

func (*inspectionCallbackFailure) Error() string {
	return "COMPUTER_ACCESS_INSPECTION_CALLBACK_REFUSED"
}
func (e *inspectionCallbackFailure) Unwrap() error {
	return errors.Join(unavailable(), e.cause)
}

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
func WithClosedInspection(ctx context.Context, root string, binding Binding, expected [32]byte, visit func(ClosedInspection) error) (err error) {
	if ctx == nil || ctx.Err() != nil || !validBinding(binding) || !absolute(root) || expected == ([32]byte{}) || visit == nil {
		return unavailable()
	}
	canonical, e := filepath.EvalSymlinks(root)
	if e != nil || canonical != root {
		return unavailable()
	}
	d := &disk{root: root, dir: -1, lock: -1}
	defer func() {
		if d.close() != nil {
			err = unavailable()
		}
	}()
	d.dir, e = unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if e != nil {
		return unavailable()
	}
	d.identity, e = fdstat(d.dir)
	if e != nil || !private(d.identity, unix.S_IFDIR, 0700) {
		return unavailable()
	}
	d.lock, e = unix.Openat(d.dir, lockName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return unavailable()
	}
	d.lockIdentity, e = fdstat(d.lock)
	if e != nil || !private(d.lockIdentity, unix.S_IFREG, 0600) || d.lockIdentity.Size != 0 || unix.Flock(d.lock, unix.LOCK_EX|unix.LOCK_NB) != nil || d.check() != nil {
		return unavailable()
	}
	var named unix.Stat_t
	if unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil {
		return unavailable()
	}
	raw, e := d.read()
	if e != nil || sha256.Sum256(raw) != expected {
		return unavailable()
	}
	state, e := decodeState(binding, raw)
	if e != nil {
		return unavailable()
	}
	recheck := func() error {
		if ctx.Err() != nil || d.check() != nil {
			return unavailable()
		}
		current, e := d.read()
		rootNow, re := fdstat(d.dir)
		lockNow, le := fdstat(d.lock)
		var currentNamed unix.Stat_t
		if e != nil || re != nil || le != nil || !bytes.Equal(raw, current) || !stableState(d.identity, rootNow) || !stableState(d.lockIdentity, lockNow) || unix.Fstatat(d.dir, stateName, &currentNamed, unix.AT_SYMLINK_NOFOLLOW) != nil || !stableState(named, currentNamed) {
			return unavailable()
		}
		return nil
	}
	if recheck() != nil {
		return unavailable()
	}
	callback := visit(ClosedInspection{Binding: binding, Digest: expected, Status: Status{Revision: state.Revision, Generation: state.Generation, ApprovalPresent: state.Approval != nil}})
	if recheck() != nil {
		return unavailable()
	}
	if callback != nil {
		return errors.New("COMPUTER_ACCESS_INSPECTION_CALLBACK_REFUSED")
	}
	return nil
}

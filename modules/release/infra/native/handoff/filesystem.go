package handoff

import (
	"context"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const dirFlags = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_DIRECTORY | unix.O_CLOEXEC
const readFlags = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
const maxRecord = 8192

type fingerprint struct {
	device, inode                                  uint64
	mode, uid, gid                                 uint32
	links                                          uint64
	size, mtimeSec, mtimeNano, ctimeSec, ctimeNano int64
}

func (a fingerprint) sameIdentity(b fingerprint) bool {
	return a.device == b.device && a.inode == b.inode && a.mode == b.mode && a.uid == b.uid && a.gid == b.gid
}
func (a fingerprint) matches(i Identity) bool {
	return strconv.FormatUint(a.device, 10) == i.Device && strconv.FormatUint(a.inode, 10) == i.Inode
}
func (a fingerprint) directory() bool { return a.mode&unix.S_IFMT == unix.S_IFDIR }
func (a fingerprint) privateFile() bool {
	return a.mode&unix.S_IFMT == unix.S_IFREG && a.uid == uint32(unix.Geteuid()) && a.links == 1 && a.mode&07777 == 0600
}
func (a fingerprint) privateRecord() bool {
	return a.mode&unix.S_IFMT == unix.S_IFREG && a.uid == uint32(unix.Geteuid()) && a.links == 1 && a.mode&0077 == 0
}
func held(ctx context.Context, fd int, code Code) (fingerprint, error) {
	if err := canceled(ctx); err != nil {
		return fingerprint{}, err
	}
	var s unix.Stat_t
	nativeErr := native(ctx).stat(fd, &s)
	if err := nativeFailure(ctx, code, nativeErr); err != nil {
		return fingerprint{}, err
	}
	return metadata(s), nil
}
func named(ctx context.Context, parent int, name string, code Code) (fingerprint, bool, error) {
	if err := canceled(ctx); err != nil {
		return fingerprint{}, false, err
	}
	var s unix.Stat_t
	err := native(ctx).named(parent, name, &s, unix.AT_SYMLINK_NOFOLLOW)
	// ENOENT remains semantic absence, unless cancellation invalidates the
	// observation. Every other failed observation retains its native cause.
	if err == unix.ENOENT && canceled(ctx) == nil {
		return fingerprint{}, false, nil
	}
	if e := nativeFailure(ctx, code, err); e != nil {
		return fingerprint{}, false, e
	}
	return metadata(s), true, nil
}

func openDirectory(ctx context.Context, parent int, name string, home bool) (fd int, err error) {
	typeCode, changedCode := ErrPathType, ErrPathReplaced
	if home {
		typeCode, changedCode = ErrHomeType, ErrHomeReplaced
	}
	fd = -1
	accepted := false
	defer func() {
		if !accepted || err != nil {
			closeOwned(ctx, &fd, &err)
		}
	}()
	before, exists, err := named(ctx, parent, name, typeCode)
	if err != nil {
		return -1, err
	}
	owner := before.uid == uint32(unix.Geteuid()) || home && before.uid == 0
	if !exists || !before.directory() || !owner || before.mode&0022 != 0 {
		return -1, typeCode
	}
	fd, err = native(ctx).openat(parent, name, dirFlags, 0)
	if e := nativeFailure(ctx, typeCode, err); e != nil {
		err = e
		return
	}
	after, err := held(ctx, fd, changedCode)
	if err != nil {
		return fd, err
	}
	if !before.sameIdentity(after) {
		return fd, changedCode
	}
	accepted = true
	return fd, nil
}

// openRoute always starts at the physical root and opens each fixed component
// without following links. There is no runtime ancestor relaxation for Cloud.
func openRoute(ctx context.Context, homePath string) (homeFD, stateFD int, err error) {
	homeFD, stateFD = -1, -1
	current, next := -1, -1
	accepted := false
	defer func() {
		closeOwned(ctx, &next, &err)
		closeOwned(ctx, &current, &err)
		err = finish(ctx, err)
		if !accepted || err != nil {
			closeOwned(ctx, &stateFD, &err)
			closeOwned(ctx, &homeFD, &err)
		}
	}()
	if err = canceled(ctx); err != nil {
		return
	}
	if !validHome(homePath) {
		err = ErrInput
		return
	}
	current, err = native(ctx).open("/", dirFlags, 0)
	if e := nativeFailure(ctx, ErrHomeType, err); e != nil {
		err = e
		return
	}
	root, e := held(ctx, current, ErrHomeType)
	if e != nil {
		err = e
		return
	}
	if !root.directory() || root.uid != 0 && root.uid != uint32(unix.Geteuid()) || root.mode&0022 != 0 {
		err = ErrHomeType
		return
	}
	for _, part := range strings.Split(homePath[1:], "/") {
		next, err = openDirectory(ctx, current, part, true)
		if err != nil {
			return
		}
		closeOwned(ctx, &current, &err)
		current, next = next, -1
		if err != nil {
			return
		}
	}
	home, e := held(ctx, current, ErrHomeOwner)
	if e != nil {
		err = e
		return
	}
	if home.uid != uint32(unix.Geteuid()) {
		err = ErrHomeOwner
		return
	}
	homeFD, current = current, -1
	for _, part := range []string{"Library", "Application Support", "io.github.legrch.farol", "farol-state"} {
		parent := homeFD
		if current >= 0 {
			parent = current
		}
		next, err = openDirectory(ctx, parent, part, false)
		if err != nil {
			return
		}
		closeOwned(ctx, &current, &err)
		current, next = next, -1
		if err != nil {
			return
		}
	}
	stateFD, current = current, -1
	accepted = true
	return
}

func (v *Verifier) verifyInherited(ctx context.Context, home, state, lease int) (err error) {
	if err := v.verifyRoute(ctx, home, state); err != nil {
		return err
	}
	return v.verifyLease(ctx, state, lease)
}

func (v *Verifier) verifyRoute(ctx context.Context, home, state int) (err error) {
	currentHome, currentState, err := v.reopen(ctx, v.homePath)
	defer func() {
		closeOwned(ctx, &currentState, &err)
		closeOwned(ctx, &currentHome, &err)
	}()
	if err != nil {
		return err
	}
	namedHome, err := held(ctx, currentHome, ErrStateChanged)
	if err != nil {
		return err
	}
	heldHome, err := held(ctx, home, ErrStateChanged)
	if err != nil {
		return err
	}
	if !namedHome.sameIdentity(heldHome) {
		return ErrStateChanged
	}
	namedState, err := held(ctx, currentState, ErrStateChanged)
	if err != nil {
		return err
	}
	heldState, err := held(ctx, state, ErrStateChanged)
	if err != nil {
		return err
	}
	if !namedState.sameIdentity(heldState) || namedState.links != heldState.links || !heldState.directory() || heldState.uid != uint32(unix.Geteuid()) || heldState.mode&07777 != 0700 || !heldState.matches(v.expected.StateIdentity) {
		return ErrStateChanged
	}
	return canceled(ctx)
}

func (v *Verifier) verifyLease(ctx context.Context, state, lease int) error {
	before, exists, err := named(ctx, state, "promotion.lease", ErrLeaseIdentity)
	if err != nil {
		return err
	}
	inherited, err := held(ctx, lease, ErrLeaseIdentity)
	if err != nil {
		return err
	}
	if !exists || !before.privateFile() || !inherited.privateFile() || !before.sameIdentity(inherited) || !inherited.matches(v.expected.LeaseIdentity) {
		return ErrLeaseIdentity
	}
	flags, err := native(ctx).flags(uintptr(lease), unix.F_GETFL, 0)
	if e := nativeFailure(ctx, ErrLeaseAccess, err); e != nil {
		return e
	}
	if flags&unix.O_ACCMODE != unix.O_RDWR {
		return ErrLeaseAccess
	}
	if err = canceled(ctx); err != nil {
		return err
	}
	if err = checkInheritedProbe(ctx, state, inherited); err != nil {
		return err
	}
	if err = canceled(ctx); err != nil {
		return err
	}
	// Idempotent only on the inherited locked open-file description. A crossed
	// description must fail; this never unlocks the inherited description.
	if err := nativeFailure(ctx, ErrLeaseCrossed, native(ctx).flock(lease, unix.LOCK_EX|unix.LOCK_NB)); err != nil {
		return err
	}
	current, exists, err := named(ctx, state, "promotion.lease", ErrLeaseIdentity)
	if err != nil {
		return err
	}
	after, err := held(ctx, lease, ErrLeaseIdentity)
	if err != nil {
		return err
	}
	if !exists || !current.privateFile() || !after.privateFile() || !current.sameIdentity(inherited) || !after.sameIdentity(inherited) {
		return ErrLeaseIdentity
	}
	return canceled(ctx)
}

func checkInheritedProbe(ctx context.Context, state int, inherited fingerprint) (err error) {
	if err := canceled(ctx); err != nil {
		return err
	}
	probe, err := native(ctx).openat(state, "promotion.lease", readFlags, 0)
	defer func() { closeOwned(ctx, &probe, &err) }()
	if e := nativeFailure(ctx, ErrLeaseProbe, err); e != nil {
		return e
	}
	// Only this independent, verifier-owned description is closed. If a shared
	// probe unexpectedly succeeds, closing it releases that probe lock only.
	p, err := held(ctx, probe, ErrLeaseIdentity)
	if err != nil {
		return err
	}
	if !p.privateFile() || !p.sameIdentity(inherited) {
		return ErrLeaseIdentity
	}
	err = native(ctx).flock(probe, unix.LOCK_SH|unix.LOCK_NB)
	if canceled(ctx) != nil {
		return nativeFailure(ctx, ErrLeaseProbe, err)
	}
	if err == nil {
		return ErrLeaseUnheld
	}
	if err != unix.EWOULDBLOCK && err != unix.EAGAIN {
		return nativeFailure(ctx, ErrLeaseProbe, err)
	}
	return nil
}

func readQuit(ctx context.Context, state int) (data []byte, err error) {
	return readRecord(ctx, state, "last-quit.json", maxRecord)
}

func readRecord(ctx context.Context, state int, name string, limit int) (data []byte, err error) {
	before, exists, err := named(ctx, state, name, ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	if !exists || !before.privateRecord() || before.size < 1 || before.size > int64(limit) {
		return nil, ErrQuitChanged
	}
	fd, err := native(ctx).openat(state, name, readFlags, 0)
	defer func() {
		closeOwned(ctx, &fd, &err)
		if err != nil {
			data = nil
		}
	}()
	if e := nativeFailure(ctx, ErrQuitChanged, err); e != nil {
		return nil, e
	}
	return readPinnedRecord(ctx, state, fd, name, limit, before)
}

func readPinnedQuit(ctx context.Context, state, fd int, before fingerprint) ([]byte, error) {
	return readPinnedRecord(ctx, state, fd, "last-quit.json", maxRecord, before)
}

func readPinnedRecord(ctx context.Context, state, fd int, name string, limit int, before fingerprint) ([]byte, error) {
	pinned, err := held(ctx, fd, ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	if pinned != before {
		return nil, ErrQuitChanged
	}
	data := make([]byte, limit+1)
	n := 0
	for n < len(data) {
		if err = canceled(ctx); err != nil {
			return nil, err
		}
		count, e := native(ctx).read(fd, data[n:])
		if err := nativeFailure(ctx, ErrQuitChanged, e); err != nil {
			return nil, err
		}
		n += count
		if count == 0 {
			break
		}
	}
	after, err := held(ctx, fd, ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	current, exists, err := named(ctx, state, name, ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	if !exists || int64(n) != before.size || after != before || current != before {
		return nil, ErrQuitChanged
	}
	return data[:n], nil
}

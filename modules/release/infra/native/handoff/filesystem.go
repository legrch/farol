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
	if unix.Fstat(fd, &s) != nil {
		return fingerprint{}, code
	}
	if err := canceled(ctx); err != nil {
		return fingerprint{}, err
	}
	return metadata(s), nil
}
func named(ctx context.Context, parent int, name string, code Code) (fingerprint, bool, error) {
	if err := canceled(ctx); err != nil {
		return fingerprint{}, false, err
	}
	var s unix.Stat_t
	err := unix.Fstatat(parent, name, &s, unix.AT_SYMLINK_NOFOLLOW)
	if e := canceled(ctx); e != nil {
		return fingerprint{}, false, e
	}
	if err == unix.ENOENT {
		return fingerprint{}, false, nil
	}
	if err != nil {
		return fingerprint{}, false, code
	}
	return metadata(s), true, nil
}

func openDirectory(ctx context.Context, parent int, name string, home bool) (int, error) {
	typeCode, changedCode := ErrPathType, ErrPathReplaced
	if home {
		typeCode, changedCode = ErrHomeType, ErrHomeReplaced
	}
	before, exists, err := named(ctx, parent, name, typeCode)
	if err != nil {
		return -1, err
	}
	owner := before.uid == uint32(unix.Geteuid()) || home && before.uid == 0
	if !exists || !before.directory() || !owner || before.mode&0022 != 0 {
		return -1, typeCode
	}
	fd, err := unix.Openat(parent, name, dirFlags, 0)
	if err != nil {
		return -1, typeCode
	}
	after, err := held(ctx, fd, changedCode)
	if err != nil || !before.sameIdentity(after) {
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		return -1, changedCode
	}
	return fd, nil
}

// openRoute always starts at the physical root and opens each fixed component
// without following links. There is no runtime ancestor relaxation for Cloud.
func openRoute(ctx context.Context, homePath string) (homeFD, stateFD int, err error) {
	homeFD, stateFD = -1, -1
	if err = canceled(ctx); err != nil {
		return
	}
	if !validHome(homePath) {
		err = ErrInput
		return
	}
	current, e := unix.Open("/", dirFlags, 0)
	if e != nil {
		err = ErrHomeType
		return
	}
	defer func() {
		if current >= 0 {
			unix.Close(current)
		}
	}()
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
		next, e := openDirectory(ctx, current, part, true)
		if e != nil {
			err = e
			return
		}
		unix.Close(current)
		current = next
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
	defer func() {
		if err != nil {
			unix.Close(homeFD)
			homeFD = -1
		}
	}()
	parent := homeFD
	for _, part := range []string{"Library", "Application Support", "Farol Next Preview", "farol-next-state"} {
		next, e := openDirectory(ctx, parent, part, false)
		if parent != homeFD {
			unix.Close(parent)
		}
		if e != nil {
			err = e
			return
		}
		parent = next
	}
	stateFD = parent
	return
}

func (v *Verifier) verifyInherited(ctx context.Context, home, state, lease int) error {
	currentHome, currentState, err := v.reopen(ctx, v.homePath)
	if err != nil {
		return err
	}
	defer unix.Close(currentHome)
	defer unix.Close(currentState)
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
	flags, err := unix.FcntlInt(uintptr(lease), unix.F_GETFL, 0)
	if err != nil || flags&unix.O_ACCMODE != unix.O_RDWR {
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
	if unix.Flock(lease, unix.LOCK_EX|unix.LOCK_NB) != nil {
		return ErrLeaseCrossed
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

func checkInheritedProbe(ctx context.Context, state int, inherited fingerprint) error {
	if err := canceled(ctx); err != nil {
		return err
	}
	probe, err := unix.Openat(state, "promotion.lease", readFlags, 0)
	if err != nil {
		return ErrLeaseProbe
	}
	// Only this independent, verifier-owned description is closed. If a shared
	// probe unexpectedly succeeds, closing it releases that probe lock only.
	defer unix.Close(probe)
	p, err := held(ctx, probe, ErrLeaseIdentity)
	if err != nil {
		return err
	}
	if !p.privateFile() || !p.sameIdentity(inherited) {
		return ErrLeaseIdentity
	}
	err = unix.Flock(probe, unix.LOCK_SH|unix.LOCK_NB)
	if c := canceled(ctx); c != nil {
		return c
	}
	if err == nil {
		return ErrLeaseUnheld
	}
	if err != unix.EWOULDBLOCK && err != unix.EAGAIN {
		return ErrLeaseProbe
	}
	return nil
}

func readQuit(ctx context.Context, state int) ([]byte, error) {
	before, exists, err := named(ctx, state, "last-quit.json", ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	if !exists || !before.privateRecord() || before.size < 1 || before.size > maxRecord {
		return nil, ErrQuitChanged
	}
	fd, err := unix.Openat(state, "last-quit.json", readFlags, 0)
	if err != nil {
		return nil, ErrQuitChanged
	}
	defer unix.Close(fd)
	return readPinnedQuit(ctx, state, fd, before)
}

func readPinnedQuit(ctx context.Context, state, fd int, before fingerprint) ([]byte, error) {
	pinned, err := held(ctx, fd, ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	if pinned != before {
		return nil, ErrQuitChanged
	}
	data := make([]byte, maxRecord+1)
	n := 0
	for n < len(data) {
		if err = canceled(ctx); err != nil {
			return nil, err
		}
		count, e := unix.Read(fd, data[n:])
		if e != nil {
			return nil, ErrQuitChanged
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
	current, exists, err := named(ctx, state, "last-quit.json", ErrQuitChanged)
	if err != nil {
		return nil, err
	}
	if !exists || int64(n) != before.size || after != before || current != before {
		return nil, ErrQuitChanged
	}
	return data[:n], nil
}

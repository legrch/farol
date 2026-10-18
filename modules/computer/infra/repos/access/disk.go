package access

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const stateName = "computer-access.json"
const lockName = "computer-access.lock"

type disk struct {
	root          string
	dir, lock     int
	identity      unix.Stat_t
	lockIdentity  unix.Stat_t
	syncDirectory func(int) error
	syncSnapshot  func(int) error
	cleanup       nativeCleanup
	cleanupErr    error
	closeErr      error
	closed        bool
}

func private(s unix.Stat_t, kind uint32, mode uint32) bool {
	return uint32(s.Mode)&unix.S_IFMT == kind && uint32(s.Mode)&07777 == mode && s.Uid == uint32(os.Geteuid()) && (kind == unix.S_IFDIR || s.Nlink == 1)
}
func same(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func stableState(a, b unix.Stat_t) bool {
	return same(a, b) && a.Mode == b.Mode && a.Size == b.Size && a.Uid == b.Uid && a.Nlink == b.Nlink && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func fdstat(fd int) (unix.Stat_t, error) { var s unix.Stat_t; err := unix.Fstat(fd, &s); return s, err }
func openDisk(root string) (*disk, error) {
	return openDiskWithCleanup(root, nativeCleanup{})
}
func openDiskWithCleanup(root string, cleanup nativeCleanup) (*disk, error) {
	if !absolute(root) {
		return nil, constructorError(unavailable(), ConstructorCleanupNotAcquired)
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil || canonical != root {
		return nil, constructorError(refuse(err), ConstructorCleanupNotAcquired)
	}
	dir, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, constructorError(refuse(err), ConstructorCleanupNotAcquired)
	}
	d := &disk{root: root, dir: dir, lock: -1, syncDirectory: unix.Fsync, syncSnapshot: unix.Fsync, cleanup: cleanup}
	fail := func(primary error) (*disk, error) {
		closed := d.close()
		status := ConstructorCleanupConfirmed
		if closed != nil {
			status = ConstructorCleanupUnknown
		}
		return nil, constructorError(errors.Join(primary, closed), status)
	}
	if d.identity, err = fdstat(dir); err != nil || !private(d.identity, unix.S_IFDIR, 0700) {
		return fail(refuse(err))
	}
	d.lock, err = unix.Openat(dir, lockName, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	if err != nil {
		return fail(refuse(err))
	}
	if d.lockIdentity, err = fdstat(d.lock); err != nil || !private(d.lockIdentity, unix.S_IFREG, 0600) {
		return fail(refuse(err))
	}
	if err = unix.Flock(d.lock, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(refuse(err))
	}
	if err = d.check(); err != nil {
		return fail(err)
	}
	return d, nil
}
func (d *disk) check() error {
	if d.closed || d.dir < 0 || d.lock < 0 || d.cleanupErr != nil {
		return refuse(d.cleanupErr, d.closeErr)
	}
	var named, lock unix.Stat_t
	current, err := fdstat(d.dir)
	if err != nil || !same(current, d.identity) || !private(current, unix.S_IFDIR, 0700) {
		return refuse(err)
	}
	if err = unix.Lstat(d.root, &named); err != nil || !same(named, d.identity) || !private(named, unix.S_IFDIR, 0700) {
		return refuse(err)
	}
	current, err = fdstat(d.lock)
	if err != nil || !same(current, d.lockIdentity) || !private(current, unix.S_IFREG, 0600) {
		return refuse(err)
	}
	if err = unix.Fstatat(d.dir, lockName, &lock, unix.AT_SYMLINK_NOFOLLOW); err != nil || !same(lock, d.lockIdentity) || !private(lock, unix.S_IFREG, 0600) {
		return refuse(err)
	}
	canonical, err := filepath.EvalSymlinks(d.root)
	if err != nil || canonical != d.root {
		return refuse(err)
	}
	return nil
}
func (d *disk) close() error {
	if d.closed {
		return d.closeErr
	}
	d.closed = true
	failures := d.cleanupErr
	// A close attempt consumes the original description, even when its receipt
	// fails. Never retry a saved integer that the OS may already have reused.
	for _, owned := range []*int{&d.lock, &d.dir} {
		fd := *owned
		*owned = -1
		if fd >= 0 {
			if err := d.cleanup.fd(fd); err != nil {
				failures = errors.Join(failures, &cleanupFailure{cause: err})
			}
		}
	}
	if failures != nil {
		d.closeErr = refuse(failures)
	}
	return d.closeErr
}
func (d *disk) read() (raw []byte, err error) {
	if err = d.check(); err != nil {
		return nil, err
	}
	fd, err := unix.Openat(d.dir, stateName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, refuse(err)
	}
	f := os.NewFile(uintptr(fd), stateName)
	defer func() {
		if closed := d.closeFile(f); closed != nil {
			raw, err = nil, refuse(err, closed)
		}
	}()
	before, err := fdstat(fd)
	if err != nil || !private(before, unix.S_IFREG, 0600) || before.Size < 1 || before.Size > maxStateBytes {
		return nil, refuse(err)
	}
	raw, err = io.ReadAll(io.LimitReader(f, maxStateBytes+1))
	if err != nil || len(raw) > maxStateBytes {
		return nil, refuse(err)
	}
	after, err := fdstat(fd)
	var named unix.Stat_t
	// Reading may change atime; only authority-relevant metadata must remain stable.
	if err != nil || !stableState(before, after) {
		return nil, refuse(err)
	}
	if err = unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil || !stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return nil, refuse(err)
	}
	if err = d.check(); err != nil {
		return nil, err
	}
	return raw, nil
}
func digest(raw []byte) [32]byte { return sha256.Sum256(raw) }
func (d *disk) create(raw []byte) error {
	if err := d.check(); err != nil {
		return err
	}
	fd, err := unix.Openat(d.dir, stateName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	f := os.NewFile(uintptr(fd), stateName)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	closeErr := d.closeFile(f)
	if err != nil || closeErr != nil {
		return &CommitFailure{Unknown: true, cause: errors.Join(err, closeErr)}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.check(); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}
func (d *disk) write(raw []byte, expected [32]byte) error {
	return d.writeWithPublication(raw, expected, nil)
}

// A current-consent refusal before rename is known and leaves Store usable for
// safe observation/retirement. This classification never covers an attempted
// publication or an error after it.
type publicationRefusal struct{ cause error }

func (e *publicationRefusal) Error() string { return unavailable().Error() }
func (e *publicationRefusal) Unwrap() error { return errors.Join(unavailable(), e.cause) }

func (d *disk) writeWithPublication(raw []byte, expected [32]byte, withPublication func(func() error) error) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	var token [16]byte
	if _, err = rand.Read(token[:]); err != nil {
		return refuse(err)
	}
	name := ".computer-access-" + hex.EncodeToString(token[:]) + ".tmp"
	fd, err := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	f := os.NewFile(uintptr(fd), name)
	attempted, renamed := false, false
	defer func() {
		if !renamed {
			if removed := unix.Unlinkat(d.dir, name, 0); removed != nil && !errors.Is(removed, unix.ENOENT) {
				if attempted {
					err = &CommitFailure{Unknown: true, cause: errors.Join(err, removed)}
				} else {
					err = refuse(err, removed)
				}
			}
		}
	}()
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	closed := d.closeFile(f)
	if err != nil || closed != nil {
		return refuse(err, closed)
	}
	if err = d.check(); err != nil {
		return err
	}
	current, err := d.read()
	if err != nil || digest(current) != expected {
		return refuse(err)
	}
	// Store is already locked. Acquire any current owner gates only at final
	// publication, in Store -> owner order; never acquire Store inside them.
	calls, publicationClosed := 0, false
	var publicationErr error
	publish := func() error {
		if publicationClosed {
			return unavailable()
		}
		calls++
		if calls != 1 {
			return unavailable()
		}
		attempted = true
		if renameErr := unix.Renameat(d.dir, name, d.dir, stateName); renameErr != nil {
			publicationErr = &CommitFailure{Unknown: true, cause: renameErr}
		} else {
			renamed = true
		}
		return publicationErr
	}
	if withPublication == nil {
		err = publish()
	} else {
		err = withPublication(publish)
	}
	publicationClosed = true
	if !attempted {
		return &publicationRefusal{cause: err}
	}
	// Once rename was attempted, a lost/malformed guard acknowledgement or any
	// durability/readback failure remains UNKNOWN, even with visible new bytes.
	if err != nil || calls != 1 || publicationErr != nil {
		return &CommitFailure{Unknown: true, cause: errors.Join(err, publicationErr)}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.check(); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	current, err = d.read()
	if err != nil || digest(current) != digest(raw) {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

// confirm is a mandatory restore durability/reconciliation barrier. Observing
// a visible rename alone cannot enable authority after publication uncertainty.
// It never changes bytes, revision, participants or approval and never replays
// the original update/admission. The assembler receives no usable owner until
// both native syncs and the exact post-sync observation have succeeded.
func (d *disk) confirm(expected []byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	fd, err := unix.Openat(d.dir, stateName, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), stateName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			err = refuse(err, closed)
		}
	}()
	before, err := fdstat(fd)
	if err != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(expected)) {
		return refuse(err)
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if err != nil || statErr != nil || !bytes.Equal(raw, expected) || !stableState(before, after) {
		return refuse(err, statErr)
	}
	if err = unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil || !stableState(named, after) {
		return refuse(err)
	}
	if err = d.check(); err != nil {
		return err
	}
	if err = d.syncSnapshot(fd); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	after, err = fdstat(fd)
	if err != nil || !stableState(before, after) {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW); err != nil || !stableState(named, after) {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.check(); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	current, err := d.read()
	if err != nil || !bytes.Equal(current, expected) {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

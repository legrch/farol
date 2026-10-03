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
	if !absolute(root) {
		return nil, unavailable()
	}
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil || canonical != root {
		return nil, unavailable()
	}
	dir, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, unavailable()
	}
	d := &disk{root: root, dir: dir, lock: -1, syncDirectory: unix.Fsync, syncSnapshot: unix.Fsync}
	fail := func() (*disk, error) { d.close(); return nil, unavailable() }
	if d.identity, err = fdstat(dir); err != nil || !private(d.identity, unix.S_IFDIR, 0700) {
		return fail()
	}
	d.lock, err = unix.Openat(dir, lockName, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0600)
	if err != nil {
		return fail()
	}
	if d.lockIdentity, err = fdstat(d.lock); err != nil || !private(d.lockIdentity, unix.S_IFREG, 0600) {
		return fail()
	}
	if unix.Flock(d.lock, unix.LOCK_EX|unix.LOCK_NB) != nil || d.check() != nil {
		return fail()
	}
	return d, nil
}
func (d *disk) check() error {
	if d.dir < 0 || d.lock < 0 {
		return unavailable()
	}
	var named, lock unix.Stat_t
	current, err := fdstat(d.dir)
	if err != nil || !same(current, d.identity) || !private(current, unix.S_IFDIR, 0700) || unix.Lstat(d.root, &named) != nil || !same(named, d.identity) || !private(named, unix.S_IFDIR, 0700) {
		return unavailable()
	}
	current, err = fdstat(d.lock)
	if err != nil || !same(current, d.lockIdentity) || !private(current, unix.S_IFREG, 0600) || unix.Fstatat(d.dir, lockName, &lock, unix.AT_SYMLINK_NOFOLLOW) != nil || !same(lock, d.lockIdentity) || !private(lock, unix.S_IFREG, 0600) {
		return unavailable()
	}
	canonical, err := filepath.EvalSymlinks(d.root)
	if err != nil || canonical != d.root {
		return unavailable()
	}
	return nil
}
func (d *disk) close() error {
	var err error
	if d.lock >= 0 {
		err = unix.Close(d.lock)
		d.lock = -1
	}
	if d.dir >= 0 {
		err = errors.Join(err, unix.Close(d.dir))
		d.dir = -1
	}
	return err
}
func (d *disk) read() ([]byte, error) {
	if d.check() != nil {
		return nil, unavailable()
	}
	fd, err := unix.Openat(d.dir, stateName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, unavailable()
	}
	f := os.NewFile(uintptr(fd), stateName)
	defer f.Close()
	before, err := fdstat(fd)
	if err != nil || !private(before, unix.S_IFREG, 0600) || before.Size < 1 || before.Size > maxStateBytes {
		return nil, unavailable()
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxStateBytes+1))
	if err != nil || len(raw) > maxStateBytes {
		return nil, unavailable()
	}
	after, err := fdstat(fd)
	var named unix.Stat_t
	// Reading may change atime; only authority-relevant metadata must remain stable.
	if err != nil || !stableState(before, after) || unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !stableState(named, after) || !private(named, unix.S_IFREG, 0600) || d.check() != nil {
		return nil, unavailable()
	}
	return raw, nil
}
func digest(raw []byte) [32]byte { return sha256.Sum256(raw) }
func (d *disk) create(raw []byte) error {
	if d.check() != nil {
		return unavailable()
	}
	fd, err := unix.Openat(d.dir, stateName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return unavailable()
	}
	f := os.NewFile(uintptr(fd), stateName)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil || d.syncDirectory(d.dir) != nil || d.check() != nil {
		return &CommitFailure{Unknown: true}
	}
	return nil
}
func (d *disk) write(raw []byte, expected [32]byte) error {
	if d.check() != nil {
		return unavailable()
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return unavailable()
	}
	name := ".computer-access-" + hex.EncodeToString(token[:]) + ".tmp"
	fd, err := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return unavailable()
	}
	f := os.NewFile(uintptr(fd), name)
	defer unix.Unlinkat(d.dir, name, 0)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	closed := f.Close()
	if err != nil || closed != nil || d.check() != nil {
		return unavailable()
	}
	current, err := d.read()
	if err != nil || digest(current) != expected {
		return unavailable()
	}
	// From the publication attempt onward an error may have changed current state.
	// The caller poisons its owner, retains the file and never retries a mutation.
	if unix.Renameat(d.dir, name, d.dir, stateName) != nil || d.syncDirectory(d.dir) != nil || d.check() != nil {
		return &CommitFailure{Unknown: true}
	}
	current, err = d.read()
	if err != nil || digest(current) != digest(raw) {
		return &CommitFailure{Unknown: true}
	}
	return nil
}

// confirm is a mandatory restore durability/reconciliation barrier. Observing
// a visible rename alone cannot enable authority after publication uncertainty.
// It never changes bytes, revision, participants or approval and never replays
// the original update/admission. The assembler receives no usable owner until
// both native syncs and the exact post-sync observation have succeeded.
func (d *disk) confirm(expected []byte) error {
	if d.check() != nil {
		return unavailable()
	}
	fd, err := unix.Openat(d.dir, stateName, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return unavailable()
	}
	file := os.NewFile(uintptr(fd), stateName)
	defer file.Close()
	before, err := fdstat(fd)
	if err != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(expected)) {
		return unavailable()
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if err != nil || statErr != nil || !bytes.Equal(raw, expected) || !stableState(before, after) || unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !stableState(named, after) || d.check() != nil {
		return unavailable()
	}
	if d.syncSnapshot(fd) != nil || d.syncDirectory(d.dir) != nil {
		return &CommitFailure{Unknown: true}
	}
	after, err = fdstat(fd)
	if err != nil || !stableState(before, after) || unix.Fstatat(d.dir, stateName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !stableState(named, after) || d.check() != nil {
		return &CommitFailure{Unknown: true}
	}
	current, err := d.read()
	if err != nil || !bytes.Equal(current, expected) {
		return &CommitFailure{Unknown: true}
	}
	return nil
}

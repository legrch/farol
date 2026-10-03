//go:build darwin || linux

package lifecycle

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

const claimName = "chat-lifecycle.claim"
const snapshotName = "chat-lifecycle.json"

// Claim is permanent, independent of backend generation and never removed by
// Close. O_EXCL supplies cross-instance ownership even after a crash. Flock is
// additional lifetime serialization, never a stale/PID/time stealing mechanism.
type disk struct {
	root                       Root
	dir, claim                 int
	dirIdentity, claimIdentity unix.Stat_t
	closed                     bool
	closeErr                   error
}

func physical(s unix.Stat_t, kind, mode uint32, uid uint32) bool {
	return uint32(s.Mode)&unix.S_IFMT == kind && uint32(s.Mode)&07777 == mode && s.Uid == uid && (kind == unix.S_IFDIR || s.Nlink == 1)
}
func same(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func stable(a, b unix.Stat_t) bool {
	return same(a, b) && a.Mode == b.Mode && a.Uid == b.Uid && a.Size == b.Size && a.Nlink == b.Nlink && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func stat(fd int) (unix.Stat_t, error) {
	var value unix.Stat_t
	err := unix.Fstat(fd, &value)
	return value, err
}

func openDisk(ctx context.Context, root Root) (*disk, error) { return openClaim(ctx, root, false) }

// Only the origin-qualified retirement constructor selects this path. It takes
// the existing claim lock without creating/replacing a claim or stealing a lock.
func openRetiredDisk(ctx context.Context, root Root) (*disk, error) {
	return openClaim(ctx, root, true)
}

func openClaim(ctx context.Context, root Root, retired bool) (*disk, error) {
	if ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	if !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || root.Device == 0 || root.Inode == 0 || root.OwnerUID != uint32(os.Geteuid()) {
		return nil, failure(Invalid, false)
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return nil, failure(Refused, false)
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, failure(Refused, false)
	}
	d := &disk{root: root, dir: fd, claim: -1}
	fail := func(c Code, unknown bool) (*disk, error) {
		if d.close() != nil {
			unknown = true
		}
		return nil, failure(c, unknown)
	}
	d.dirIdentity, err = stat(fd)
	if err != nil || !physical(d.dirIdentity, unix.S_IFDIR, 0700, root.OwnerUID) || uint64(d.dirIdentity.Dev) != root.Device || uint64(d.dirIdentity.Ino) != root.Inode {
		return fail(Refused, false)
	}
	if ctx.Err() != nil {
		return fail(Cancelled, false)
	}
	flags := unix.O_RDWR | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	if !retired {
		flags |= unix.O_CREAT | unix.O_EXCL
	}
	d.claim, err = unix.Openat(fd, claimName, flags, 0600)
	if err != nil {
		return fail(Refused, false)
	}
	d.claimIdentity, err = stat(d.claim)
	if err != nil || !physical(d.claimIdentity, unix.S_IFREG, 0600, root.OwnerUID) {
		if retired {
			return fail(Refused, false)
		}
		return fail(Unknown, true)
	}
	if unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB) != nil {
		if retired {
			return fail(Refused, false)
		}
		return fail(Unknown, true)
	}
	// An empty permanent claim is already an unresolved fence. Sync both its
	// physical entry and the directory before returning a usable repository.
	if unix.Fsync(d.claim) != nil || unix.Fsync(d.dir) != nil || d.check() != nil || ctx.Err() != nil {
		return fail(Unknown, true)
	}
	return d, nil
}
func (d *disk) check() error {
	if d.closed || d.dir < 0 || d.claim < 0 {
		return failure(Unavailable, false)
	}
	current, err := stat(d.dir)
	var named, claim unix.Stat_t
	if err != nil || !same(current, d.dirIdentity) || !physical(current, unix.S_IFDIR, 0700, d.root.OwnerUID) || unix.Lstat(d.root.Path, &named) != nil || !same(named, d.dirIdentity) || !physical(named, unix.S_IFDIR, 0700, d.root.OwnerUID) {
		return failure(Unavailable, false)
	}
	current, err = stat(d.claim)
	if err != nil || !same(current, d.claimIdentity) || !physical(current, unix.S_IFREG, 0600, d.root.OwnerUID) || unix.Fstatat(d.dir, claimName, &claim, unix.AT_SYMLINK_NOFOLLOW) != nil || !same(claim, d.claimIdentity) || !physical(claim, unix.S_IFREG, 0600, d.root.OwnerUID) {
		return failure(Unavailable, false)
	}
	canonical, err := filepath.EvalSymlinks(d.root.Path)
	if err != nil || canonical != d.root.Path {
		return failure(Unavailable, false)
	}
	return nil
}
func (d *disk) read(limit int) ([]byte, error) {
	if limit < 1 || d.check() != nil {
		return nil, failure(Unavailable, false)
	}
	fd, err := unix.Openat(d.dir, snapshotName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, failure(Unavailable, false)
	}
	f := os.NewFile(uintptr(fd), snapshotName)
	before, err := stat(fd)
	if err != nil || !physical(before, unix.S_IFREG, 0600, d.root.OwnerUID) || before.Size < 1 || before.Size > int64(limit) {
		closed := f.Close()
		return nil, failure(Unavailable, closed != nil)
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	after, statErr := stat(fd)
	var named unix.Stat_t
	qualified := err == nil && statErr == nil && len(raw) <= limit && stable(before, after) && unix.Fstatat(d.dir, snapshotName, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && stable(named, after) && physical(named, unix.S_IFREG, 0600, d.root.OwnerUID) && d.check() == nil
	closed := f.Close()
	if !qualified || closed != nil {
		return nil, failure(Unavailable, closed != nil)
	}
	return raw, nil
}
func (d *disk) create(ctx context.Context, raw []byte) error {
	if ctx.Err() != nil {
		return failure(Cancelled, false)
	}
	if d.check() != nil {
		return failure(Unavailable, false)
	}
	fd, err := unix.Openat(d.dir, snapshotName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return failure(Refused, false)
	}
	f := os.NewFile(uintptr(fd), snapshotName)
	meta, err := stat(fd)
	if err != nil || !physical(meta, unix.S_IFREG, 0600, d.root.OwnerUID) {
		f.Close()
		return failure(Unknown, true)
	}
	n, writeErr := f.Write(raw)
	synced := writeErr == nil && n == len(raw) && f.Sync() == nil
	closed := f.Close()
	if !synced || closed != nil || unix.Fsync(d.dir) != nil || d.check() != nil || ctx.Err() != nil {
		return failure(Unknown, true)
	}
	return nil
}
func (d *disk) replace(ctx context.Context, raw []byte, expected [32]byte, readLimit int) error {
	if ctx.Err() != nil {
		return failure(Cancelled, false)
	}
	if d.check() != nil {
		return failure(Unavailable, false)
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return failure(Unavailable, false)
	}
	name := ".chat-lifecycle-" + hex.EncodeToString(nonce[:]) + ".tmp"
	fd, err := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return failure(Unavailable, false)
	}
	f := os.NewFile(uintptr(fd), name)
	meta, err := stat(fd)
	if err != nil || !physical(meta, unix.S_IFREG, 0600, d.root.OwnerUID) {
		f.Close()
		return failure(Unknown, true)
	}
	n, writeErr := f.Write(raw)
	synced := writeErr == nil && n == len(raw) && f.Sync() == nil
	closed := f.Close()
	// Preserve temp files on EVERY failure; Close never performs uncertain cleanup.
	if !synced || closed != nil || d.check() != nil {
		return failure(Unknown, true)
	}
	current, err := d.read(readLimit)
	if err != nil {
		return err
	}
	if sha256.Sum256(current) != expected {
		return failure(Unavailable, false)
	}
	if ctx.Err() != nil {
		return failure(Cancelled, false)
	}
	// Native claim plus one shared repository owner serializes legitimate writers.
	// CAS is checked against exact prior bytes before atomic rename publication.
	if unix.Renameat(d.dir, name, d.dir, snapshotName) != nil || unix.Fsync(d.dir) != nil || d.check() != nil || ctx.Err() != nil {
		return failure(Unknown, true)
	}
	current, err = d.read(len(raw))
	if err != nil || sha256.Sum256(current) != sha256.Sum256(raw) {
		return failure(Unknown, true)
	}
	return nil
}

func (d *disk) close() error {
	if d.closed {
		return d.closeErr
	}
	d.closed = true
	var err error
	if d.claim >= 0 {
		fd := d.claim
		d.claim = -1
		err = unix.Close(fd)
	}
	if d.dir >= 0 {
		fd := d.dir
		d.dir = -1
		err = errors.Join(err, unix.Close(fd))
	}
	d.closeErr = err
	return err
}

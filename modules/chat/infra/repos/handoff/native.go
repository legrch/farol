//go:build darwin || linux

package handoff

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

const claimName = "chat-handoff.claim"
const unknownName = "chat-handoff.unknown"

type disk struct {
	roots                          Roots
	parent, dir, claim             int
	parentMeta, dirMeta, claimMeta unix.Stat_t
	closed                         bool
	closeErr                       error
	poisonAttempted                bool
	poisonErr                      error
}

func stat(fd int) (unix.Stat_t, error) { var s unix.Stat_t; err := unix.Fstat(fd, &s); return s, err }
func physical(s unix.Stat_t, kind, mode, uid uint32) bool {
	return uint32(s.Mode)&unix.S_IFMT == kind && uint32(s.Mode)&07777 == mode && s.Uid == uid && (kind == unix.S_IFDIR || s.Nlink == 1)
}
func same(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func stable(a, b unix.Stat_t) bool {
	return same(a, b) && a.Mode == b.Mode && a.Uid == b.Uid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func qualified(s unix.Stat_t, r port.JournalRoot) bool {
	return physical(s, unix.S_IFDIR, 0700, r.OwnerUID) && uint64(s.Dev) == r.Device && uint64(s.Ino) == r.Inode && r.Device != 0 && r.Inode != 0
}
func openDisk(ctx context.Context, roots Roots) (storage, error) {
	uid := uint32(os.Geteuid())
	if roots.ProfileID == "" || len(roots.ProfileID) > 120 || roots.Parent.Identity.OwnerUID != uid || roots.Chat.Identity.OwnerUID != uid || roots.Parent.Identity == roots.Chat.Identity || roots.Parent.Identity.Device != roots.Chat.Identity.Device || !filepath.IsAbs(roots.Parent.Path) || filepath.Clean(roots.Parent.Path) != roots.Parent.Path || roots.Chat.Path != filepath.Join(roots.Parent.Path, "chat") {
		return nil, fail(Invalid, false)
	}
	// Boot additionally qualifies the full ancestor chain. Here no symlink in the
	// supplied spelling may be normalized into the selected root.
	canonical, err := filepath.EvalSymlinks(roots.Parent.Path)
	if err != nil || canonical != roots.Parent.Path {
		return nil, fail(Refused, false)
	}
	d := &disk{roots: roots, parent: -1, dir: -1, claim: -1}
	failure := func(c Code) (storage, error) {
		if d.close() != nil {
			return nil, fail(Unknown, true)
		}
		return nil, fail(c, c == Unknown)
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	d.parent, err = unix.Open(roots.Parent.Path, flags, 0)
	if err != nil {
		return failure(Refused)
	}
	d.parentMeta, err = stat(d.parent)
	if err != nil || !qualified(d.parentMeta, roots.Parent.Identity) {
		return failure(Refused)
	}
	d.dir, err = unix.Openat(d.parent, "chat", flags, 0)
	if err != nil {
		return failure(Refused)
	}
	d.dirMeta, err = stat(d.dir)
	if err != nil || !qualified(d.dirMeta, roots.Chat.Identity) {
		return failure(Refused)
	}
	if ctx.Err() != nil {
		return failure(Cancelled)
	}
	// The permanent lock is created only on a never-used root. Existing claims are
	// opened as-is; no replacement, mode repair, stale cleanup or unlink occurs.
	cf := unix.O_RDWR | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	var namedClaim unix.Stat_t
	if e := unix.Fstatat(d.dir, claimName, &namedClaim, unix.AT_SYMLINK_NOFOLLOW); errors.Is(e, unix.ENOENT) {
		if d.inventory(1) != nil {
			return failure(Refused)
		}
	} else if e != nil {
		return failure(Refused)
	}
	d.claim, err = unix.Openat(d.dir, claimName, cf|unix.O_CREAT|unix.O_EXCL, 0600)
	if errors.Is(err, unix.EEXIST) {
		d.claim, err = unix.Openat(d.dir, claimName, cf, 0)
	}
	if err != nil {
		return failure(Refused)
	}
	d.claimMeta, err = stat(d.claim)
	if err != nil || !physical(d.claimMeta, unix.S_IFREG, 0600, uid) {
		return failure(Refused)
	}
	if unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB) != nil {
		return failure(Refused)
	}
	if unix.Fsync(d.claim) != nil || unix.Fsync(d.dir) != nil || d.check() != nil || ctx.Err() != nil {
		return failure(Unknown)
	}
	return d, nil
}
func (d *disk) check() error {
	if d.closed || d.parent < 0 || d.dir < 0 || d.claim < 0 {
		return fail(Unavailable, false)
	}
	var named, up unix.Stat_t
	p, e := stat(d.parent)
	if e != nil || !same(p, d.parentMeta) || !qualified(p, d.roots.Parent.Identity) || unix.Lstat(d.roots.Parent.Path, &named) != nil || !same(named, p) || !qualified(named, d.roots.Parent.Identity) {
		return fail(Refused, false)
	}
	c, e := stat(d.dir)
	if e != nil || !same(c, d.dirMeta) || !qualified(c, d.roots.Chat.Identity) || unix.Fstatat(d.parent, "chat", &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !same(named, c) || !qualified(named, d.roots.Chat.Identity) || unix.Fstatat(d.dir, "..", &up, unix.AT_SYMLINK_NOFOLLOW) != nil || !same(up, p) {
		return fail(Refused, false)
	}
	claim, e := stat(d.claim)
	if e != nil || !same(claim, d.claimMeta) || !physical(claim, unix.S_IFREG, 0600, d.roots.Chat.Identity.OwnerUID) || unix.Fstatat(d.dir, claimName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !same(named, claim) || !physical(named, unix.S_IFREG, 0600, d.roots.Chat.Identity.OwnerUID) {
		return fail(Refused, false)
	}
	canonical, e := filepath.EvalSymlinks(d.roots.Parent.Path)
	if e != nil || canonical != d.roots.Parent.Path {
		return fail(Refused, false)
	}
	if err := unix.Fstatat(d.dir, unknownName, &named, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		return fail(Unknown, true)
	} else if !errors.Is(err, unix.ENOENT) {
		return fail(Unknown, true)
	}
	return nil
}
func stepName(index int, kind string) string { return fmt.Sprintf("chat-handoff-%04d.%s", index, kind) }
func (d *disk) readFile(name string, limit int) ([]byte, bool, error) {
	fd, err := unix.Openat(d.dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fail(Refused, false)
	}
	f := os.NewFile(uintptr(fd), name)
	before, err := stat(fd)
	if err != nil || !physical(before, unix.S_IFREG, 0600, d.roots.Chat.Identity.OwnerUID) || before.Size < 1 || before.Size > int64(limit) {
		f.Close()
		return nil, false, fail(Unknown, true)
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	after, se := stat(fd)
	var named unix.Stat_t
	ok := err == nil && se == nil && len(raw) <= limit && stable(before, after) && unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && stable(named, after)
	closed := f.Close()
	if !ok || closed != nil {
		return nil, false, fail(Unknown, true)
	}
	return raw, true, nil
}
func (d *disk) read(ctx context.Context, index int) ([]byte, bool, error) {
	if ctx.Err() != nil || d.check() != nil {
		return nil, false, fail(Unknown, true)
	}
	raw, attempt, err := d.readFile(stepName(index, "attempt"), maxBytes)
	if err != nil {
		return nil, false, err
	}
	committed, commit, err := d.readFile(stepName(index, "commit"), 64)
	if err != nil {
		return nil, false, err
	}
	if !attempt && !commit {
		if d.inventory(index) != nil {
			return nil, false, fail(Unknown, true)
		}
		return nil, false, nil
	}
	if !attempt || !commit {
		return nil, false, fail(Unknown, true)
	}
	sum := sha256.Sum256(raw)
	if !bytes.Equal(committed, []byte(hex.EncodeToString(sum[:]))) {
		return nil, false, fail(Unknown, true)
	}
	if d.check() != nil || ctx.Err() != nil {
		return nil, false, fail(Unknown, true)
	}
	return raw, true, nil
}
func (d *disk) write(ctx context.Context, name string, raw []byte) error {
	if ctx.Err() != nil || d.check() != nil {
		return fail(Unknown, true)
	}
	fd, err := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return fail(Unknown, true)
	}
	f := os.NewFile(uintptr(fd), name)
	meta, err := stat(fd)
	if err != nil || !physical(meta, unix.S_IFREG, 0600, d.roots.Chat.Identity.OwnerUID) {
		f.Close()
		return fail(Unknown, true)
	}
	n, e := f.Write(raw)
	ok := e == nil && n == len(raw) && f.Sync() == nil
	closed := f.Close()
	if !ok || closed != nil || unix.Fsync(d.dir) != nil || d.check() != nil || ctx.Err() != nil {
		return fail(Unknown, true)
	}
	visible, present, e := d.readFile(name, len(raw))
	if e != nil || !present || !bytes.Equal(visible, raw) {
		return fail(Unknown, true)
	}
	return nil
}

// poison is a one-shot best-effort additional durable fence. Partial attempt or
// commit files already block reopening. No failed operation is retried/cleaned.
func (d *disk) poison() error {
	if d.poisonAttempted {
		return d.poisonErr
	}
	d.poisonAttempted = true
	current, err := stat(d.dir)
	if err != nil || !same(current, d.dirMeta) || !qualified(current, d.roots.Chat.Identity) {
		d.poisonErr = fail(Unknown, true)
		return d.poisonErr
	}
	fd, err := unix.Openat(d.dir, unknownName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if errors.Is(err, unix.EEXIST) {
		return nil
	}
	if err != nil {
		d.poisonErr = fail(Unknown, true)
		return d.poisonErr
	}
	f := os.NewFile(uintptr(fd), unknownName)
	meta, e := stat(fd)
	if e != nil || !physical(meta, unix.S_IFREG, 0600, d.roots.Chat.Identity.OwnerUID) {
		f.Close()
		d.poisonErr = fail(Unknown, true)
		return d.poisonErr
	}
	n, e := f.Write([]byte("UNKNOWN"))
	ok := e == nil && n == 7 && f.Sync() == nil
	closed := f.Close()
	if !ok || closed != nil || unix.Fsync(d.dir) != nil {
		d.poisonErr = fail(Unknown, true)
	}
	return d.poisonErr
}
func (d *disk) append(ctx context.Context, index int, raw []byte) (err error) {
	if index < 1 || index > maxSteps || len(raw) > maxBytes {
		return fail(Invalid, false)
	}
	if err = d.write(ctx, stepName(index, "attempt"), raw); err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	return d.write(ctx, stepName(index, "commit"), []byte(hex.EncodeToString(sum[:])))
}
func (d *disk) close() error {
	if d.closed {
		return d.closeErr
	}
	d.closed = true
	for _, fd := range []int{d.claim, d.dir, d.parent} {
		if fd >= 0 {
			d.closeErr = errors.Join(d.closeErr, unix.Close(fd))
		}
	}
	d.claim, d.dir, d.parent = -1, -1, -1
	return d.closeErr
}

// inventory bounds names and refuses gaps, orphan commits, unexpected handoff
// artifacts, or a removed claim followed by retained evidence. Unrelated Chat
// files are not decoded, modified or treated as retirement evidence.
func (d *disk) inventory(firstMissing int) error {
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(Unknown, true)
	}
	f := os.NewFile(uintptr(fd), "chat-handoff-directory")
	entries, err := f.ReadDir(2*maxSteps + 128)
	closed := f.Close()
	if err != nil && err != io.EOF || closed != nil || len(entries) >= 2*maxSteps+128 {
		return fail(Unknown, true)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "chat-handoff") {
			continue
		}
		if name == claimName {
			continue
		}
		if name == unknownName {
			return fail(Unknown, true)
		}
		suffix := strings.TrimPrefix(name, "chat-handoff-")
		parts := strings.Split(suffix, ".")
		if len(parts) != 2 || (parts[1] != "attempt" && parts[1] != "commit") {
			return fail(Unknown, true)
		}
		index, err := strconv.Atoi(parts[0])
		if err != nil || index < 1 || index > maxSteps || name != stepName(index, parts[1]) || index >= firstMissing {
			return fail(Unknown, true)
		}
	}
	return nil
}

//go:build darwin || linux

package results

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

const resultChild = "chat-results"
const resultClaim = "chat-results.claim"
const resultUnknown = "chat-results.unknown"

type resultClaimRecord struct {
	Version           uint32
	ProfileID         string
	Root, StorageRoot port.JournalRoot
}
type resultDisk struct {
	root                         Root
	rootFD, dir, claim           int
	rootMeta, dirMeta, claimMeta unix.Stat_t
	childIdentity                port.JournalRoot
	closed, poisonAttempted      bool
	closeErr, poisonErr          error
}

// NewNative selects exactly create or open. Create never opens an existing child;
// open never creates a missing child/claim or repairs modes, locks or records.
func NewNative(ctx, lifetime context.Context, root Root, scope port.JournalScope, limits Limits, mode string) (*Native, error) {
	if !validResultComposition(ctx, lifetime, root, scope, limits, mode) {
		return nil, Invalid
	}
	d, err := openResultDisk(ctx, root, mode)
	if err != nil {
		return nil, err
	}
	return newResultOwner(ctx, lifetime, root, scope, limits, d)
}
func resultStat(fd int) (unix.Stat_t, error) {
	var s unix.Stat_t
	err := unix.Fstat(fd, &s)
	return s, err
}
func resultPhysical(s unix.Stat_t, kind, mode, uid uint32) bool {
	return uint32(s.Mode)&unix.S_IFMT == kind && uint32(s.Mode)&07777 == mode && s.Uid == uid && (kind == unix.S_IFDIR || s.Nlink == 1)
}
func resultSame(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func resultStable(a, b unix.Stat_t) bool {
	return resultSame(a, b) && a.Mode == b.Mode && a.Uid == b.Uid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func resultQualified(s unix.Stat_t, r port.JournalRoot) bool {
	return resultPhysical(s, unix.S_IFDIR, 0700, r.OwnerUID) && uint64(s.Dev) == r.Device && uint64(s.Ino) == r.Inode && r.Device != 0 && r.Inode != 0
}
func openResultDisk(ctx context.Context, root Root, mode string) (*resultDisk, error) {
	if root.Identity.OwnerUID != uint32(os.Geteuid()) || !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path {
		return nil, Invalid
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return nil, Refused
	}
	d := &resultDisk{root: root, rootFD: -1, dir: -1, claim: -1}
	mutated := false
	failure := func(code Code) (*resultDisk, error) {
		if mutated {
			_ = d.poison()
			code = Unknown
		}
		if d.close() != nil {
			code = Unknown
		}
		return nil, resultFailure(code, code == Unknown)
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	d.rootFD, err = unix.Open(root.Path, flags, 0)
	if err != nil {
		return failure(Refused)
	}
	d.rootMeta, err = resultStat(d.rootFD)
	if err != nil || !resultQualified(d.rootMeta, root.Identity) || d.checkRoots(false) != nil {
		return failure(Refused)
	}
	if ctx.Err() != nil {
		return failure(Unavailable)
	}
	if mode == "create" {
		if err = unix.Mkdirat(d.rootFD, resultChild, 0700); err != nil {
			return failure(Refused)
		}
		mutated = true
	}
	d.dir, err = unix.Openat(d.rootFD, resultChild, flags, 0)
	if err != nil {
		return failure(Refused)
	}
	d.dirMeta, err = resultStat(d.dir)
	if err != nil || !resultPhysical(d.dirMeta, unix.S_IFDIR, 0700, root.Identity.OwnerUID) {
		return failure(Refused)
	}
	d.childIdentity = port.JournalRoot{Device: uint64(d.dirMeta.Dev), Inode: uint64(d.dirMeta.Ino), OwnerUID: d.dirMeta.Uid}
	if !validRoots(root.Identity, d.childIdentity) || d.checkRoots(true) != nil {
		return failure(Refused)
	}
	// Claim bytes bind even an empty store to its original profile and roots.
	expected, _ := json.Marshal(resultClaimRecord{1, root.ProfileID, root.Identity, d.childIdentity})
	cf := unix.O_RDWR | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	if mode == "create" {
		cf |= unix.O_CREAT | unix.O_EXCL
	}
	d.claim, err = unix.Openat(d.dir, resultClaim, cf, 0600)
	if err != nil {
		return failure(Refused)
	}
	d.claimMeta, err = resultStat(d.claim)
	var named unix.Stat_t
	if err != nil || !resultPhysical(d.claimMeta, unix.S_IFREG, 0600, root.Identity.OwnerUID) || unix.Fstatat(d.dir, resultClaim, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, d.claimMeta) {
		return failure(Refused)
	}
	if unix.Flock(d.claim, unix.LOCK_EX|unix.LOCK_NB) != nil {
		return failure(Refused)
	}
	if mode == "create" {
		if d.claimMeta.Size != 0 || d.checkRoots(true) != nil {
			return failure(Unknown)
		}
		written, err := unix.Write(d.claim, expected)
		if err != nil || written != len(expected) || unix.Fsync(d.claim) != nil || unix.Fsync(d.dir) != nil || unix.Fsync(d.rootFD) != nil {
			return failure(Unknown)
		}
		d.claimMeta, err = resultStat(d.claim)
		if err != nil {
			return failure(Unknown)
		}
	}
	if d.check() != nil || ctx.Err() != nil {
		return failure(Unknown)
	}
	actual, err := d.readFile(ctx, resultClaim, len(expected))
	if err != nil || !bytes.Equal(actual, expected) {
		return failure(Unknown)
	}
	if d.check() != nil || ctx.Err() != nil {
		return failure(Unknown)
	}
	return d, nil
}
func (d *resultDisk) identity() port.JournalRoot { return d.childIdentity }
func (d *resultDisk) checkRoots(child bool) error {
	if d.closed || d.rootFD < 0 || d.root.Identity.OwnerUID != uint32(os.Geteuid()) {
		return Refused
	}
	var named, up unix.Stat_t
	root, err := resultStat(d.rootFD)
	if err != nil || !resultSame(root, d.rootMeta) || !resultQualified(root, d.root.Identity) || unix.Lstat(d.root.Path, &named) != nil || !resultSame(named, root) || !resultQualified(named, d.root.Identity) {
		return Refused
	}
	canonical, err := filepath.EvalSymlinks(d.root.Path)
	if err != nil || canonical != d.root.Path {
		return Refused
	}
	if !child {
		return nil
	}
	current, err := resultStat(d.dir)
	if err != nil || !resultSame(current, d.dirMeta) || !resultQualified(current, d.childIdentity) || unix.Fstatat(d.rootFD, resultChild, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultSame(named, current) || !resultQualified(named, d.childIdentity) || unix.Fstatat(d.dir, "..", &up, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultSame(up, root) {
		return Refused
	}
	return nil
}
func (d *resultDisk) checkPhysical() error {
	if d.checkRoots(true) != nil || d.claim < 0 {
		return Refused
	}
	current, err := resultStat(d.claim)
	var named unix.Stat_t
	if err != nil || !resultStable(current, d.claimMeta) || !resultPhysical(current, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || unix.Fstatat(d.dir, resultClaim, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, current) {
		return Refused
	}
	return nil
}
func (d *resultDisk) check() error {
	if d.checkPhysical() != nil {
		return Refused
	}
	var named unix.Stat_t
	if err := unix.Fstatat(d.dir, resultUnknown, &named, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
		return resultFailure(Unknown, true)
	}
	return nil
}
func validResultKey(key string) bool {
	if len(key) != 64 {
		return false
	}
	for _, b := range key {
		if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'f') {
			return false
		}
	}
	return true
}
func (d *resultDisk) inventory(ctx context.Context) ([]string, error) {
	if ctx.Err() != nil || d.check() != nil {
		return nil, resultFailure(Unknown, true)
	}
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, resultFailure(Unknown, true)
	}
	f := os.NewFile(uintptr(fd), "chat-results-directory")
	opened, se := resultStat(fd)
	if se != nil || !resultSame(opened, d.dirMeta) || !resultQualified(opened, d.childIdentity) {
		_ = f.Close()
		return nil, resultFailure(Unknown, true)
	}
	entries, err := f.ReadDir(2*MaxResults + 3)
	after, se := resultStat(fd)
	closed := f.Close()
	if err != nil && err != io.EOF || se != nil || !resultStable(opened, after) || closed != nil || len(entries) >= 2*MaxResults+3 {
		return nil, resultFailure(Unknown, true)
	}
	masks := make(map[string]uint8)
	claimSeen := false
	for _, entry := range entries {
		name := entry.Name()
		if name == resultClaim {
			claimSeen = true
			continue
		}
		key, kind, ok := strings.Cut(name, ".")
		if !ok || !validResultKey(key) || (kind != "attempt" && kind != "commit") {
			return nil, resultFailure(Unknown, true)
		}
		bit := uint8(1)
		if kind == "commit" {
			bit = 2
		}
		if masks[key]&bit != 0 {
			return nil, resultFailure(Unknown, true)
		}
		masks[key] |= bit
	}
	if !claimSeen || len(masks) > MaxResults {
		return nil, resultFailure(Unknown, true)
	}
	keys := make([]string, 0, len(masks))
	for key, mask := range masks {
		if mask != 3 {
			return nil, resultFailure(Unknown, true)
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if d.check() != nil || ctx.Err() != nil {
		return nil, resultFailure(Unknown, true)
	}
	return keys, nil
}
func (d *resultDisk) readFile(ctx context.Context, name string, limit int) ([]byte, error) {
	if ctx.Err() != nil || d.check() != nil {
		return nil, resultFailure(Unknown, true)
	}
	fd, err := unix.Openat(d.dir, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, resultFailure(Unknown, true)
	}
	f := os.NewFile(uintptr(fd), "chat-result-record")
	before, err := resultStat(fd)
	var named unix.Stat_t
	if err != nil || !resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || before.Size < 1 || before.Size > int64(limit) || unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, before) {
		_ = f.Close()
		return nil, resultFailure(Unknown, true)
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	after, se := resultStat(fd)
	ok := err == nil && se == nil && len(raw) == int(before.Size) && resultStable(before, after) && unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && resultStable(named, after)
	closed := f.Close()
	if !ok || closed != nil || d.check() != nil || ctx.Err() != nil {
		return nil, resultFailure(Unknown, true)
	}
	return raw, nil
}
func (d *resultDisk) read(ctx context.Context, key string) ([]byte, error) {
	if !validResultKey(key) {
		return nil, Invalid
	}
	raw, err := d.readFile(ctx, key+".attempt", port.MaxResultRecordBytes)
	if err != nil {
		return nil, err
	}
	commit, err := d.readFile(ctx, key+".commit", 64)
	sum := sha256.Sum256(raw)
	if err != nil || !bytes.Equal(commit, []byte(hex.EncodeToString(sum[:]))) || d.check() != nil || ctx.Err() != nil {
		return nil, resultFailure(Unknown, true)
	}
	return raw, nil
}
func (d *resultDisk) write(ctx context.Context, name string, raw []byte) error {
	if ctx.Err() != nil || d.check() != nil {
		return resultFailure(Unknown, true)
	}
	fd, err := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return resultFailure(Unknown, true)
	}
	f := os.NewFile(uintptr(fd), "chat-result-publication")
	before, err := resultStat(fd)
	var named unix.Stat_t
	if err != nil || !resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || before.Size != 0 || unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, before) || d.check() != nil {
		_ = f.Close()
		return resultFailure(Unknown, true)
	}
	written, we := f.Write(raw)
	synced := f.Sync()
	after, se := resultStat(fd)
	ok := we == nil && written == len(raw) && synced == nil && se == nil && resultSame(before, after) && resultPhysical(after, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) && after.Size == int64(len(raw)) && unix.Fstatat(d.dir, name, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && resultStable(named, after)
	closed := f.Close()
	if !ok || closed != nil || unix.Fsync(d.dir) != nil || d.check() != nil || ctx.Err() != nil {
		return resultFailure(Unknown, true)
	}
	readback, err := d.readFile(ctx, name, len(raw))
	if err != nil || !bytes.Equal(readback, raw) {
		return resultFailure(Unknown, true)
	}
	return nil
}
func (d *resultDisk) append(ctx context.Context, key string, raw []byte) error {
	if !validResultKey(key) || len(raw) == 0 || len(raw) > port.MaxResultRecordBytes {
		return Invalid
	}
	if err := d.write(ctx, key+".attempt", raw); err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	return d.write(ctx, key+".commit", []byte(hex.EncodeToString(sum[:])))
}

// poison ignores caller cancellation: it is a single bounded best-effort fence.
// It cannot guarantee durability under arbitrary storage/power failure.
func (d *resultDisk) poison() error {
	if d.poisonAttempted {
		return d.poisonErr
	}
	d.poisonAttempted = true
	failed := func() error { d.poisonErr = resultFailure(Unknown, true); return d.poisonErr }
	if d.checkPhysical() != nil {
		return failed()
	}
	fd, err := unix.Openat(d.dir, resultUnknown, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	// Even a malformed/preexisting marker fences open; do not repair it or claim
	// this owner established its durability.
	if err != nil {
		return failed()
	}
	f := os.NewFile(uintptr(fd), "chat-result-unknown")
	before, err := resultStat(fd)
	var named unix.Stat_t
	if err != nil || !resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || before.Size != 0 || unix.Fstatat(d.dir, resultUnknown, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, before) || d.checkPhysical() != nil {
		_ = f.Close()
		return failed()
	}
	written, we := f.Write([]byte("UNKNOWN"))
	synced := f.Sync()
	after, se := resultStat(fd)
	ok := we == nil && written == 7 && synced == nil && se == nil && resultSame(before, after) && resultPhysical(after, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) && after.Size == 7 && unix.Fstatat(d.dir, resultUnknown, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && resultStable(named, after)
	closed := f.Close()
	if !ok || closed != nil || unix.Fsync(d.dir) != nil || d.checkPhysical() != nil {
		return failed()
	}
	// Read the marker without check(), which intentionally refuses any marker.
	fd, err = unix.Openat(d.dir, resultUnknown, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return failed()
	}
	f = os.NewFile(uintptr(fd), "chat-result-unknown-readback")
	before, se = resultStat(fd)
	if se != nil || !resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) || before.Size != 7 || unix.Fstatat(d.dir, resultUnknown, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !resultStable(named, before) || d.checkPhysical() != nil {
		_ = f.Close()
		return failed()
	}
	raw, re := io.ReadAll(io.LimitReader(f, 8))
	after, ae := resultStat(fd)
	ok = se == nil && ae == nil && re == nil && resultPhysical(before, unix.S_IFREG, 0600, d.root.Identity.OwnerUID) && resultStable(before, after) && unix.Fstatat(d.dir, resultUnknown, &named, unix.AT_SYMLINK_NOFOLLOW) == nil && resultStable(named, after) && bytes.Equal(raw, []byte("UNKNOWN"))
	closed = f.Close()
	if !ok || closed != nil || d.checkPhysical() != nil {
		return failed()
	}
	return nil
}
func (d *resultDisk) close() error {
	if d.closed {
		return d.closeErr
	}
	d.closed = true
	for _, fd := range []int{d.claim, d.dir, d.rootFD} {
		if fd >= 0 && unix.Close(fd) != nil {
			d.closeErr = resultFailure(Unknown, true)
		}
	}
	d.claim, d.dir, d.rootFD = -1, -1, -1
	return d.closeErr
}

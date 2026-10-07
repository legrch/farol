//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"

	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"golang.org/x/sys/unix"
)

func emptyRecoveryParent(in ProfileBinding) (fd int, err error) {
	fd, err = unix.Open(in.Root, profileOpenFlags, 0)
	if err != nil {
		return -1, handoff.Refused
	}
	var s unix.Stat_t
	if unix.Fstat(fd, &s) != nil || uint64(s.Dev) != in.Device || s.Ino != in.Inode || s.Uid != uint32(os.Geteuid()) || uint32(s.Mode)&07777 != 0700 {
		unix.Close(fd)
		return -1, handoff.Refused
	}
	return fd, nil
}

func preserveEmptyRecoveryChat(ctx context.Context, in emptyRecoveryInspectionInput, v emptyRecoveryInspection, claims *emptyRecoveryChatClaims) (_ *emptyRecoveryPreservation, resultErr error) {
	if ctx == nil || ctx.Err() != nil || claims == nil || claims.preserved != nil || v.Plan.Selection != in.Selection || claims.h.Verify() != nil || claims.l.Verify() != nil || claims.r.Verify() != nil {
		return nil, handoff.Refused
	}
	fd, err := emptyRecoveryParent(in.Profile)
	if err != nil {
		return nil, err
	}
	defer func() {
		if unix.Close(fd) != nil {
			resultErr = handoff.Unknown
		}
	}()
	intentParent, err := unix.Openat(fd, "..", profileOpenFlags, 0)
	if err != nil {
		return nil, handoff.Refused
	}
	defer func() {
		if unix.Close(intentParent) != nil {
			resultErr = handoff.Unknown
		}
	}()
	intentName := filepath.Base(in.Profile.Root) + emptyRecoveryPending
	var absent unix.Stat_t
	if !errors.Is(unix.Fstatat(fd, v.Plan.ArchiveName, &absent, unix.AT_SYMLINK_NOFOLLOW), unix.ENOENT) || !errors.Is(unix.Fstatat(intentParent, intentName, &absent, unix.AT_SYMLINK_NOFOLLOW), unix.ENOENT) {
		return nil, handoff.Refused
	}
	files, err := emptyRecoveryArchiveFiles(ctx, v.Chat)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(in)
	if err != nil || len(raw) > 65536 {
		return nil, handoff.Invalid
	}
	// One permanent intent, before the first preservation/creation effect.
	// No retry, replacement, deletion, automatic rollback or UNKNOWN upgrade.
	f, err := unix.Openat(intentParent, intentName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, handoff.Unknown
	}
	file := os.NewFile(uintptr(f), emptyRecoveryPending)
	n, writeErr := file.Write(raw)
	syncErr := file.Sync()
	var intent unix.Stat_t
	statErr := unix.Fstat(f, &intent)
	closeErr := file.Close()
	if n != len(raw) || writeErr != nil || syncErr != nil || statErr != nil || uint32(intent.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(intent.Mode)&07777 != 0600 || intent.Uid != v.Chat.OwnerUID || intent.Nlink != 1 || intent.Size != int64(len(raw)) || closeErr != nil || unix.Fsync(intentParent) != nil || ctx.Err() != nil {
		return nil, fmt.Errorf("pending durability: %w", handoff.Unknown)
	}
	if err := claims.h.Verify(); err != nil {
		return nil, fmt.Errorf("old handoff recheck: %w", errors.Join(handoff.Unknown, err))
	}
	if err := claims.l.Verify(); err != nil {
		return nil, fmt.Errorf("old lifecycle recheck: %w", errors.Join(handoff.Unknown, err))
	}
	if err := claims.r.Verify(); err != nil {
		return nil, fmt.Errorf("old results recheck: %w", errors.Join(handoff.Unknown, err))
	}
	current, err := emptyRecoveryArchiveFiles(ctx, v.Chat)
	if err != nil || !reflect.DeepEqual(files, current) {
		return nil, fmt.Errorf("old inventory recheck: %w", errors.Join(handoff.Unknown, err))
	}
	if err := unix.RenameatxNp(fd, "chat", fd, v.Plan.ArchiveName, unix.RENAME_EXCL|unix.RENAME_NOFOLLOW_ANY); err != nil {
		return nil, fmt.Errorf("archive rename: %w", errors.Join(handoff.Unknown, err))
	}
	if unix.Fsync(fd) != nil {
		return nil, fmt.Errorf("archive durability: %w", handoff.Unknown)
	}
	archive := v.Chat
	archive.Path = filepath.Join(in.Profile.Root, v.Plan.ArchiveName)
	if unix.Mkdirat(fd, "chat", 0700) != nil || unix.Fsync(fd) != nil {
		return nil, handoff.Unknown
	}
	var fresh unix.Stat_t
	if unix.Fstatat(fd, "chat", &fresh, unix.AT_SYMLINK_NOFOLLOW) != nil || uint32(fresh.Mode)&unix.S_IFMT != unix.S_IFDIR || uint32(fresh.Mode)&07777 != 0700 || fresh.Uid != v.Chat.OwnerUID || uint64(fresh.Dev) != v.Chat.Device || fresh.Ino == v.Chat.Inode {
		return nil, handoff.Unknown
	}
	p := &emptyRecoveryPreservation{Archive: archive, NewChat: NativeRoot{Path: v.Chat.Path, ProfileID: v.Chat.ProfileID, Device: uint64(fresh.Dev), Inode: fresh.Ino, OwnerUID: fresh.Uid, Mode: 0700}, Files: files, PendingDigest: sha256.Sum256(raw), PendingIdentity: emptyRecoveryFile{Device: uint64(intent.Dev), Inode: intent.Ino, Mode: uint32(intent.Mode), OwnerUID: intent.Uid, SHA256: sha256.Sum256(raw)}}
	if verifyEmptyRecoveryPreservation(ctx, in.Profile, v.Computer, v.Task, p) != nil {
		return nil, handoff.Unknown
	}
	return p, nil
}

func verifyEmptyRecoveryPreservation(ctx context.Context, binding ProfileBinding, computer, task NativeRoot, p *emptyRecoveryPreservation) (resultErr error) {
	if p == nil || ctx == nil || ctx.Err() != nil {
		return handoff.Refused
	}
	q, err := QualifyProfile(binding)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, q.Close()) }()
	c, ch, err := q.Roots()
	t, te := q.TaskRoot()
	if err != nil || te != nil || c != computer || ch != p.NewChat || t != task {
		return handoff.Unknown
	}
	files, err := emptyRecoveryArchiveFiles(ctx, p.Archive)
	if err != nil || !reflect.DeepEqual(files, p.Files) {
		return handoff.Unknown
	}
	intent, err := emptyRecoveryPendingFile(binding.Root)
	if err != nil || intent != p.PendingIdentity || intent.SHA256 != p.PendingDigest {
		return handoff.Unknown
	}
	return nil
}

func emptyRecoveryPendingFile(root string) (value emptyRecoveryFile, resultErr error) {
	file := emptyRecoveryPendingPath(root)
	fd, err := unix.Open(file, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return value, handoff.Refused
	}
	f := os.NewFile(uintptr(fd), "empty-recovery-intent")
	defer func() {
		if f.Close() != nil {
			resultErr = handoff.Unknown
		}
	}()
	var a, b, n unix.Stat_t
	if unix.Fstat(fd, &a) != nil || uint32(a.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(a.Mode)&07777 != 0600 || a.Uid != uint32(os.Geteuid()) || a.Nlink != 1 || a.Size < 2 || a.Size > 65536 {
		return value, handoff.Refused
	}
	raw, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(raw) != int(a.Size) || unix.Fstat(fd, &b) != nil || unix.Lstat(file, &n) != nil || !sameEmptyRecoveryStat(a, b) || !sameEmptyRecoveryStat(b, n) {
		return value, handoff.Refused
	}
	return emptyRecoveryFile{Device: uint64(b.Dev), Inode: b.Ino, Mode: uint32(b.Mode), OwnerUID: b.Uid, SHA256: sha256.Sum256(raw)}, nil
}

// Exact bounded inode/content inventory of the already qualified empty Chat.
// It is preserved evidence, not a generic profile copier or authority reader.
func emptyRecoveryArchiveFiles(ctx context.Context, root NativeRoot) (result map[string]emptyRecoveryFile, resultErr error) {
	result = make(map[string]emptyRecoveryFile)
	total := 0
	var walk func(string, string, *NativeRoot) error
	walk = func(directory, relative string, selected *NativeRoot) (resultErr error) {
		fd, err := unix.Open(directory, profileOpenFlags, 0)
		if err != nil {
			return handoff.Refused
		}
		f := os.NewFile(uintptr(fd), "empty-chat-inventory")
		defer func() {
			if f.Close() != nil {
				resultErr = handoff.Unknown
			}
		}()
		var before, after, named unix.Stat_t
		if unix.Fstat(fd, &before) != nil || before.Uid != root.OwnerUID || uint32(before.Mode)&07777 != 0700 || unix.Lstat(directory, &named) != nil || named.Dev != before.Dev || named.Ino != before.Ino || selected != nil && (uint64(before.Dev) != selected.Device || before.Ino != selected.Inode) {
			return handoff.Refused
		}
		names, err := f.Readdirnames(2053)
		if err != nil && err != io.EOF || len(names) > 2052 {
			return handoff.Refused
		}
		if more, err := f.Readdirnames(1); len(more) != 0 || err != io.EOF {
			return handoff.Refused
		}
		for _, name := range names {
			if ctx.Err() != nil || len(result) >= 2052 {
				return handoff.Refused
			}
			var s unix.Stat_t
			if unix.Fstatat(fd, name, &s, unix.AT_SYMLINK_NOFOLLOW) != nil || s.Uid != root.OwnerUID {
				return handoff.Refused
			}
			key := filepath.Join(relative, name)
			if uint32(s.Mode)&unix.S_IFMT == unix.S_IFDIR {
				if relative != "" || name != "chat-results" || uint32(s.Mode)&07777 != 0700 {
					return handoff.Refused
				}
				result[key] = emptyRecoveryFile{Device: uint64(s.Dev), Inode: s.Ino, Mode: uint32(s.Mode), OwnerUID: s.Uid}
				if err := walk(filepath.Join(directory, name), key, &NativeRoot{Device: uint64(s.Dev), Inode: s.Ino}); err != nil {
					return err
				}
				continue
			}
			if uint32(s.Mode)&unix.S_IFMT != unix.S_IFREG || uint32(s.Mode)&07777 != 0600 || s.Nlink != 1 || s.Size < 0 || s.Size > 1048576 || total+int(s.Size) > 4194304 {
				return handoff.Refused
			}
			child, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
			if err != nil {
				return handoff.Refused
			}
			cf := os.NewFile(uintptr(child), "empty-chat-record")
			var a, b, n unix.Stat_t
			firstErr := unix.Fstat(child, &a)
			raw, readErr := io.ReadAll(io.LimitReader(cf, 1048577))
			lastErr := unix.Fstat(child, &b)
			nameErr := unix.Fstatat(fd, name, &n, unix.AT_SYMLINK_NOFOLLOW)
			closeErr := cf.Close()
			if firstErr != nil || readErr != nil || lastErr != nil || nameErr != nil || closeErr != nil || !sameEmptyRecoveryStat(a, s) || !sameEmptyRecoveryStat(a, b) || !sameEmptyRecoveryStat(b, n) || len(raw) != int(s.Size) {
				return handoff.Refused
			}
			total += len(raw)
			result[key] = emptyRecoveryFile{Device: uint64(s.Dev), Inode: s.Ino, Mode: uint32(s.Mode), OwnerUID: s.Uid, SHA256: sha256.Sum256(raw)}
		}
		if unix.Fstat(fd, &after) != nil || !sameEmptyRecoveryStat(before, after) || unix.Lstat(directory, &named) != nil || !sameEmptyRecoveryStat(named, after) {
			return handoff.Refused
		}
		return nil
	}
	if err := walk(root.Path, "", &root); err != nil {
		return nil, err
	}
	return result, nil
}

// Read access may update atime. Identity, ownership, links, bytes and mutation
// timestamps must stay exact; reading itself cannot constitute a write fence.
func sameEmptyRecoveryStat(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func refusePendingEmptyRecovery(profile ProfileBinding) (resultErr error) {
	fd, err := emptyRecoveryParent(profile)
	if err != nil {
		return err
	}
	defer func() {
		if unix.Close(fd) != nil {
			resultErr = handoff.Unknown
		}
	}()
	var s unix.Stat_t
	if !errors.Is(unix.Lstat(emptyRecoveryPendingPath(profile.Root), &s), unix.ENOENT) {
		return handoff.Refused
	}
	return nil
}

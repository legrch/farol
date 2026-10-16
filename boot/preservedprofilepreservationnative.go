//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"golang.org/x/sys/unix"
)

// Canonical nonempty/UNKNOWN data is already qualified by the retained composite
// claims. Reuse the original bounded physical archive inventory and permanent
// intent name; both maintenance paths exclude each other and any unknown attempt.
// This function runs only under trusted closed-host maintenance, never as an RPC.
func preserveNonemptyRecoveryChat(ctx context.Context, in preservedProfileInspectionInput, v preservedProfileInspection, claims *preservedProfileChatClaims) (_ *emptyRecoveryPreservation, resultErr error) {
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
	// This is a new maintenance operation; no old ACK/retirement is minted.
	// No retry, replacement, deletion, automatic rollback or UNKNOWN upgrade.
	if ctx.Err() != nil {
		return nil, handoff.Refused
	}
	claims.effectsStarted = true
	f, err := unix.Openat(intentParent, intentName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, handoff.Unknown
	}
	file := os.NewFile(uintptr(f), emptyRecoveryPending)
	if ctx.Err() != nil {
		return nil, errors.Join(handoff.Unknown, file.Close())
	}
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
	if err != nil || ctx.Err() != nil || claims.verifyOriginal() != nil || !reflect.DeepEqual(files, current) {
		return nil, fmt.Errorf("old inventory recheck: %w", errors.Join(handoff.Unknown, err))
	}
	if err := unix.RenameatxNp(fd, "chat", fd, v.Plan.ArchiveName, unix.RENAME_EXCL|unix.RENAME_NOFOLLOW_ANY); err != nil {
		return nil, fmt.Errorf("archive rename: %w", errors.Join(handoff.Unknown, err))
	}
	if unix.Fsync(fd) != nil || ctx.Err() != nil {
		return nil, fmt.Errorf("archive durability: %w", handoff.Unknown)
	}
	archive := v.Chat
	archive.Path = filepath.Join(in.Profile.Root, v.Plan.ArchiveName)
	if ctx.Err() != nil || unix.Mkdirat(fd, "chat", 0700) != nil || unix.Fsync(fd) != nil || ctx.Err() != nil {
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

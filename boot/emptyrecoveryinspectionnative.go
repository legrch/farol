//go:build darwin || linux

package boot

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	"golang.org/x/sys/unix"
)

func withEmptyRecoveryTask(ctx context.Context, root NativeRoot, visit func() error) (resultErr error) {
	return withEmptyRecoveryTaskInventory(ctx, root, visit, func() error { return inspectExactRecoveryDirectory(ctx, root, map[string]uint32{}) })
}

// Private native test seam lets a regression place changes at either scan
// boundary. Production always selects the real exact-directory inventory above.
func withEmptyRecoveryTaskInventory(ctx context.Context, root NativeRoot, visit func() error, inventory func() error) (resultErr error) {
	if ctx == nil || ctx.Err() != nil || visit == nil {
		return profileFailure(ProfileRefused)
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return profileFailure(ProfileRefused)
	}
	defer func() {
		if unix.Close(fd) != nil {
			resultErr = profileFailure(ProfileCleanupUnknown)
		}
	}()
	var before, after, named unix.Stat_t
	if unix.Fstat(fd, &before) != nil || uint64(before.Dev) != root.Device || uint64(before.Ino) != root.Inode {
		return profileFailure(ProfileRefused)
	}
	if inventory == nil {
		return profileFailure(ProfileRefused)
	}
	if err := inventory(); err != nil {
		return err
	}
	callbackErr := visit()
	// Span both complete scans with the SAME retained directory baseline.
	// Membership cannot be created/removed in a gap and become invisible merely
	// because the final inventory captured a fresh local timestamp baseline.
	finalInventoryErr := inventory()
	if ctx.Err() != nil || unix.Fstat(fd, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino || before.Mode != after.Mode || before.Uid != after.Uid || before.Mtim != after.Mtim || before.Ctim != after.Ctim || unix.Lstat(root.Path, &named) != nil || named.Dev != after.Dev || named.Ino != after.Ino {
		return profileFailure(ProfileRefused)
	}
	return errors.Join(callbackErr, finalInventoryErr)
}

// The top-level allowlist closes the lifecycle inspector's deliberately narrower
// snapshot scope. No hidden staging, unknown file, unrelated result or task is
// excused because a current snapshot looks empty.
func inspectEmptyRecoveryNamespaces(ctx context.Context, computer, chat, task NativeRoot, steps int) error {
	if ctx == nil || ctx.Err() != nil || steps < 1 || steps > 1024 {
		return profileFailure(ProfileRefused)
	}
	if err := inspectExactRecoveryDirectory(ctx, task, map[string]uint32{}); err != nil {
		return err
	}
	if err := inspectExactRecoveryDirectory(ctx, computer, map[string]uint32{"computer-access.json": unix.S_IFREG, "computer-access.lock": unix.S_IFREG, ".mutation-writer.lock": unix.S_IFREG, "mutations": unix.S_IFDIR}); err != nil {
		return err
	}
	chatNames := map[string]uint32{"chat-lifecycle.claim": unix.S_IFREG, "chat-lifecycle.json": unix.S_IFREG, "chat-handoff.claim": unix.S_IFREG, "chat-results": unix.S_IFDIR}
	for n := 1; n <= steps; n++ {
		chatNames[fmt.Sprintf("chat-handoff-%04d.attempt", n)] = unix.S_IFREG
		chatNames[fmt.Sprintf("chat-handoff-%04d.commit", n)] = unix.S_IFREG
	}
	return inspectExactRecoveryDirectory(ctx, chat, chatNames)
}

func inspectExactRecoveryDirectory(ctx context.Context, root NativeRoot, expected map[string]uint32) (resultErr error) {
	if ctx == nil || ctx.Err() != nil || len(expected) > 2052 {
		return profileFailure(ProfileRefused)
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return profileFailure(ProfileRefused)
	}
	f := os.NewFile(uintptr(fd), "empty-recovery-directory")
	defer func() {
		if f.Close() != nil {
			resultErr = profileFailure(ProfileCleanupUnknown)
		}
	}()
	var before, after, named unix.Stat_t
	validRoot := func(s unix.Stat_t) bool {
		return uint64(s.Dev) == root.Device && uint64(s.Ino) == root.Inode && s.Uid == root.OwnerUID && uint32(s.Mode)&unix.S_IFMT == unix.S_IFDIR && uint32(s.Mode)&07777 == 0700
	}
	if unix.Fstat(fd, &before) != nil || !validRoot(before) || unix.Lstat(root.Path, &named) != nil || !validRoot(named) {
		return profileFailure(ProfileRefused)
	}
	names, err := f.Readdirnames(len(expected) + 1)
	if err != nil && err != io.EOF || len(names) != len(expected) {
		return profileFailure(ProfileRefused)
	}
	more, endErr := f.Readdirnames(1)
	if len(more) != 0 || endErr != io.EOF {
		return profileFailure(ProfileRefused)
	}
	sort.Strings(names)
	for _, name := range names {
		kind, ok := expected[name]
		var s unix.Stat_t
		if !ok || unix.Fstatat(fd, name, &s, unix.AT_SYMLINK_NOFOLLOW) != nil || uint32(s.Mode)&unix.S_IFMT != kind || s.Uid != root.OwnerUID || kind == unix.S_IFREG && (uint32(s.Mode)&07777 != 0600 || s.Nlink != 1) || kind == unix.S_IFDIR && uint32(s.Mode)&07777 != 0700 {
			return profileFailure(ProfileRefused)
		}
		if (name == "chat-lifecycle.claim" || name == "chat-handoff.claim" || name == "computer-access.lock" || name == ".mutation-writer.lock") && s.Size != 0 {
			return profileFailure(ProfileRefused)
		}
	}
	if ctx.Err() != nil || unix.Fstat(fd, &after) != nil || !validRoot(after) || before.Mtim != after.Mtim || before.Ctim != after.Ctim || unix.Lstat(root.Path, &named) != nil || !validRoot(named) {
		return profileFailure(ProfileRefused)
	}
	return nil
}

//go:build darwin

package boot

import (
	"context"
	"fmt"
	"golang.org/x/sys/unix"
)

// The existing exact native inventory retains its original per-entry checks.
// An initial empty handoff chain has zero stage pairs; nonempty canonical stages
// have exactly their numbered attempt/commit pairs. No other name is excused.
func inspectPreservedProfileNamespaces(ctx context.Context, computer, chat, task NativeRoot, steps int) error {
	if ctx == nil || ctx.Err() != nil || steps < 0 || steps > 1024 {
		return profileFailure(ProfileRefused)
	}
	if err := inspectExactRecoveryDirectory(ctx, task, map[string]uint32{}); err != nil {
		return err
	}
	if err := inspectExactRecoveryDirectory(ctx, computer, map[string]uint32{"computer-access.json": unix.S_IFREG, "computer-access.lock": unix.S_IFREG, ".mutation-writer.lock": unix.S_IFREG, "mutations": unix.S_IFDIR}); err != nil {
		return err
	}
	names := map[string]uint32{"chat-lifecycle.claim": unix.S_IFREG, "chat-lifecycle.json": unix.S_IFREG, "chat-handoff.claim": unix.S_IFREG, "chat-results": unix.S_IFDIR}
	for n := 1; n <= steps; n++ {
		names[fmt.Sprintf("chat-handoff-%04d.attempt", n)] = unix.S_IFREG
		names[fmt.Sprintf("chat-handoff-%04d.commit", n)] = unix.S_IFREG
	}
	return inspectExactRecoveryDirectory(ctx, chat, names)
}

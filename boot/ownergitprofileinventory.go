//go:build darwin

package boot

import (
	"errors"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// The owner choice is optional for profiles created before Git selection. It
// lives inside Computer's protected child, not the writable go-core parent.
// The exact recovery inventory still checks its type, owner, mode and link
// count when it exists, and refuses every other unexpected entry.
func computerRecoveryNames(computer NativeRoot) (map[string]uint32, error) {
	names := map[string]uint32{
		"computer-access.json":  unix.S_IFREG,
		"computer-access.lock":  unix.S_IFREG,
		".mutation-writer.lock": unix.S_IFREG,
		"mutations":             unix.S_IFDIR,
	}
	var entry unix.Stat_t
	err := unix.Lstat(filepath.Join(computer.Path, "owner-git-choice.json"), &entry)
	if err == nil {
		names["owner-git-choice.json"] = unix.S_IFREG
	} else if !errors.Is(err, unix.ENOENT) {
		return nil, profileFailure(ProfileRefused)
	}
	return names, nil
}

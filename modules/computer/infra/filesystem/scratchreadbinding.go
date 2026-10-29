package filesystem

import (
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

func validScratchReadBinding(b port.ScratchReadBinding) bool {
	return mutation.ScratchLeaf(mutation.ScratchPath(b.RunID)) && b.Directory.Valid() && b.File.Valid() && b.DirectoryHold != nil && b.FileHold != nil
}

// Both descriptors are the actual objects used by the operation. The named
// checks are not a promise of continuous isolation against a same-UID process.
func scratchOpenedMatches(root, directoryFD, fileFD int, b port.ScratchReadBinding) bool {
	if !validScratchReadBinding(b) || b.DirectoryHold.Check(b.Directory) != nil || b.FileHold.Check(b.File) != nil {
		return false
	}
	var directory, namedDirectory, openedFile, namedFile unix.Stat_t
	return unix.Fstat(directoryFD, &directory) == nil && unix.Fstatat(root, mutation.ScratchPath(b.RunID), &namedDirectory, unix.AT_SYMLINK_NOFOLLOW) == nil &&
		unix.Fstat(fileFD, &openedFile) == nil && unix.Fstatat(directoryFD, "check.txt", &namedFile, unix.AT_SYMLINK_NOFOLLOW) == nil &&
		strconv.FormatUint(uint64(directory.Dev), 10) == b.Directory.Device && strconv.FormatUint(directory.Ino, 10) == b.Directory.Inode &&
		stable(directory, namedDirectory) && directory.Mode&unix.S_IFMT == unix.S_IFDIR &&
		strconv.FormatUint(uint64(openedFile.Dev), 10) == b.File.Device && strconv.FormatUint(openedFile.Ino, 10) == b.File.Inode &&
		stable(openedFile, namedFile) && openedFile.Mode&unix.S_IFMT == unix.S_IFREG && openedFile.Nlink == 1
}

//go:build darwin

package filesystem

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

type darwinMutation struct{}

func nativeMutationFS() mutationFS { return darwinMutation{} }
func (darwinMutation) root() (int, error) {
	return unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}
func (darwinMutation) open(parent int, name string, flags int, mode uint32) (int, error) {
	return unix.Openat(parent, name, flags, mode)
}
func (darwinMutation) close(fd int)              { _ = unix.Close(fd) }
func (darwinMutation) closeChecked(fd int) error { return unix.Close(fd) }
func (darwinMutation) stat(fd int) (fileVersion, error) {
	var s unix.Stat_t
	err := unix.Fstat(fd, &s)
	return mutationVersion(s), err
}
func (darwinMutation) lstat(parent int, name string) (fileVersion, error) {
	var s unix.Stat_t
	err := unix.Fstatat(parent, name, &s, unix.AT_SYMLINK_NOFOLLOW)
	return mutationVersion(s), err
}
func mutationVersion(s unix.Stat_t) fileVersion {
	return fileVersion{dev: uint64(s.Dev), ino: s.Ino, mode: uint32(s.Mode), uid: s.Uid, links: uint64(s.Nlink), size: s.Size, mtime: s.Mtim.Nano(), ctime: s.Ctim.Nano()}
}
func (darwinMutation) read(fd int, limit int) ([]byte, error) {
	data := make([]byte, 0, 4096)
	buffer := make([]byte, 64*1024)
	if _, err := unix.Seek(fd, 0, 0); err != nil {
		return nil, err
	}
	for {
		n, err := unix.Read(fd, buffer)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return data, nil
		}
		if len(data)+n > limit {
			return nil, errors.New("mutation byte limit")
		}
		data = append(data, buffer[:n]...)
	}
}
func (darwinMutation) write(fd int, data []byte) error {
	for len(data) > 0 {
		n, err := unix.Write(fd, data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return errors.New("mutation short write")
		}
		data = data[n:]
	}
	return nil
}
func (darwinMutation) chmod(fd int, mode uint32) error { return unix.Fchmod(fd, mode) }
func (darwinMutation) sync(fd int) error               { return unix.Fsync(fd) }
func (darwinMutation) mkdir(parent int, name string, mode uint32) error {
	return unix.Mkdirat(parent, name, mode)
}
func (darwinMutation) link(from int, name string, to int, target string) error {
	return unix.Linkat(from, name, to, target, 0)
}
func (darwinMutation) swap(from int, name string, to int, target string) error {
	return unix.RenameatxNp(from, name, to, target, unix.RENAME_SWAP)
}
func (darwinMutation) unlink(parent int, name string, directory bool) error {
	flags := 0
	if directory {
		flags = unix.AT_REMOVEDIR
	}
	return unix.Unlinkat(parent, name, flags)
}
func (darwinMutation) uid() uint32 { return uint32(os.Getuid()) }
func (darwinMutation) name() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return ".farol-mutation-" + hex.EncodeToString(data[:]), nil
}

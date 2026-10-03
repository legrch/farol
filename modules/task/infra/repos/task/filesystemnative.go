//go:build darwin || linux

package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/legrch/farol/modules/task/domain"
	"golang.org/x/sys/unix"
)

const filesystemLockName = ".task-journal.lock"
const filesystemImageName = "journal.json"
const filesystemPendingName = "journal.pending"
const filesystemNextName = "journal.next"

type filesystemLockRecord struct {
	ProfileID     string
	Version       uint8
	Device, Inode uint64
	UID           uint32
}
type filesystemNative struct {
	root            FilesystemRoot
	directory, lock *os.File
	uid             uint32
	lockStat, last  unix.Stat_t
	hasLast, closed bool
}

func openFilesystemStorage(root FilesystemRoot) (filesystemStorage, error) {
	if !task.ID(root.ProfileID) || !task.Text(root.Path, 4096) || root.Inode == 0 || !filepath.IsAbs(root.Path) || filepath.Clean(root.Path) != root.Path || root.Path == "/" || strings.ContainsAny(root.Path, "\x00\r\n\t\\") {
		return nil, task.ErrInvalid
	}
	canonical, err := filepath.EvalSymlinks(root.Path)
	if err != nil || canonical != root.Path {
		return nil, task.ErrUnavailable
	}
	fd, err := unix.Open(root.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, task.ErrUnavailable
	}
	n := &filesystemNative{root: root, directory: os.NewFile(uintptr(fd), "task-journal-root"), uid: uint32(os.Geteuid())}
	fail := func(cause error) (filesystemStorage, error) {
		if n.Close() != nil {
			return nil, task.ErrUnknown
		}
		return nil, cause
	}
	if n.checkDirectory() != nil {
		return fail(task.ErrUnavailable)
	}
	// Inspect bounded, fixed namespace only. No adoption of a legacy journal,
	// unowned subdirectory or unexpected contents; no recursive filesystem walk.
	names, err := n.directory.Readdirnames(5)
	if err != nil && !errors.Is(err, io.EOF) {
		return fail(task.ErrUnavailable)
	}
	if len(names) > 4 {
		return fail(task.ErrUnavailable)
	}
	for _, name := range names {
		if name != filesystemLockName && name != filesystemImageName && name != filesystemPendingName && name != filesystemNextName {
			return fail(task.ErrUnavailable)
		}
	}
	fd, err = unix.Openat(int(n.directory.Fd()), filesystemLockName, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	created := err == nil
	if errors.Is(err, unix.EEXIST) {
		fd, err = unix.Openat(int(n.directory.Fd()), filesystemLockName, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	}
	if err != nil {
		return fail(task.ErrUnavailable)
	}
	n.lock = os.NewFile(uintptr(fd), "task-journal-lease")
	if unix.Fstat(fd, &n.lockStat) != nil || !n.privateFile(n.lockStat, 512) {
		return fail(task.ErrUnavailable)
	}
	// Kernel-held lease only. Busy/unsupported/denied is terminal here; no PID,
	// clock, stale-age inspection, unlink, lock replacement or fallback executor.
	if unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB) != nil {
		return fail(task.ErrUnavailable)
	}
	header, _ := json.Marshal(filesystemLockRecord{root.ProfileID, 1, root.Device, root.Inode, n.uid})
	header = append(header, '\n')
	if created {
		if len(names) != 0 {
			return fail(task.ErrUnknown)
		}
		written, writeErr := n.lock.Write(header)
		if writeErr != nil || written != len(header) || n.lock.Sync() != nil || n.directory.Sync() != nil {
			return fail(task.ErrUnknown)
		}
		if unix.Fstat(fd, &n.lockStat) != nil || !n.privateFile(n.lockStat, 512) {
			return fail(task.ErrUnknown)
		}
		initial, err := filesystemEncode(filesystemEmpty(root.ProfileID))
		if err != nil {
			return fail(err)
		}
		if n.Publish(initial) != nil {
			return fail(task.ErrUnknown)
		}
	} else {
		data, readErr := io.ReadAll(io.LimitReader(n.lock, 513))
		var after unix.Stat_t
		if readErr != nil || unix.Fstat(fd, &after) != nil || !filesystemStable(n.lockStat, after) || !bytes.Equal(data, header) {
			return fail(task.ErrUnknown)
		}
	}
	if n.check() != nil {
		return fail(task.ErrUnavailable)
	}
	return n, nil
}
func (n *filesystemNative) privateFile(s unix.Stat_t, limit int64) bool {
	return s.Mode&(unix.S_IFMT|07777) == unix.S_IFREG|0600 && s.Uid == n.uid && s.Nlink == 1 && s.Size >= 0 && s.Size <= limit
}
func (n *filesystemNative) checkDirectory() error {
	if n.closed || uint32(os.Geteuid()) != n.uid {
		return task.ErrUnavailable
	}
	var held, named unix.Stat_t
	if unix.Fstat(int(n.directory.Fd()), &held) != nil || unix.Lstat(n.root.Path, &named) != nil {
		return task.ErrUnavailable
	}
	if held.Mode&(unix.S_IFMT|07777) != unix.S_IFDIR|0700 || held.Uid != n.uid || uint64(held.Dev) != n.root.Device || uint64(held.Ino) != n.root.Inode || held.Dev != named.Dev || held.Ino != named.Ino || named.Mode != held.Mode || named.Uid != held.Uid {
		return task.ErrUnavailable
	}
	canonical, err := filepath.EvalSymlinks(n.root.Path)
	if err != nil || canonical != n.root.Path {
		return task.ErrUnavailable
	}
	return nil
}
func (n *filesystemNative) check() error {
	if n.checkDirectory() != nil || n.lock == nil {
		return task.ErrUnavailable
	}
	var held, named unix.Stat_t
	if unix.Fstat(int(n.lock.Fd()), &held) != nil || unix.Fstatat(int(n.directory.Fd()), filesystemLockName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !n.privateFile(held, 512) || !filesystemStable(held, n.lockStat) || !filesystemStable(held, named) {
		return task.ErrUnavailable
	}
	return nil
}
func (n *filesystemNative) exists(name string) (bool, error) {
	var s unix.Stat_t
	err := unix.Fstatat(int(n.directory.Fd()), name, &s, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return false, nil
	}
	if err != nil {
		return false, task.ErrUnavailable
	}
	return true, nil // Any partial entry, including a symlink/FIFO, fences writes.
}
func (n *filesystemNative) Read() ([]byte, bool, error) {
	if n.check() != nil {
		return nil, true, task.ErrUnavailable
	}
	pending, err := n.exists(filesystemPendingName)
	if err != nil {
		return nil, true, err
	}
	next, err := n.exists(filesystemNextName)
	if err != nil {
		return nil, true, err
	}
	fd, err := unix.Openat(int(n.directory.Fd()), filesystemImageName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, true, task.ErrUnknown
	}
	file := os.NewFile(uintptr(fd), "task-journal-image")
	var before, after, named unix.Stat_t
	if unix.Fstat(fd, &before) != nil || !n.privateFile(before, filesystemMaxBytes) {
		_ = file.Close()
		return nil, true, task.ErrUnavailable
	}
	data, readErr := io.ReadAll(io.LimitReader(file, filesystemMaxBytes+1))
	statErr := unix.Fstat(fd, &after)
	nameErr := unix.Fstatat(int(n.directory.Fd()), filesystemImageName, &named, unix.AT_SYMLINK_NOFOLLOW)
	closeErr := file.Close()
	if readErr != nil || statErr != nil || nameErr != nil || closeErr != nil || int64(len(data)) != before.Size || !filesystemStable(before, after) || !filesystemStable(after, named) || n.check() != nil {
		return nil, true, task.ErrUnknown
	}
	n.last, n.hasLast = after, true
	return data, pending || next, nil
}
func (n *filesystemNative) writeNew(name string, data []byte) (unix.Stat_t, error) {
	var identity unix.Stat_t
	fd, err := unix.Openat(int(n.directory.Fd()), name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0600)
	if err != nil {
		return identity, task.ErrUnknown
	}
	file := os.NewFile(uintptr(fd), "task-journal-publication")
	// Once a name is claimed, every failure is uncertain. Preserve that exact
	// entry; no cleanup/retry may erase the evidence and reopen publication.
	written, writeErr := file.Write(data)
	if writeErr != nil || written != len(data) {
		_ = file.Close()
		return identity, task.ErrUnknown
	}
	syncErr := file.Sync()
	statErr := unix.Fstat(fd, &identity)
	closeErr := file.Close()
	if syncErr != nil || statErr != nil || closeErr != nil || !n.privateFile(identity, filesystemMaxBytes) || identity.Size != int64(len(data)) {
		return identity, task.ErrUnknown
	}
	return identity, nil
}
func (n *filesystemNative) currentImage() error {
	var named unix.Stat_t
	err := unix.Fstatat(int(n.directory.Fd()), filesystemImageName, &named, unix.AT_SYMLINK_NOFOLLOW)
	if !n.hasLast && errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil || !n.hasLast || !n.privateFile(named, filesystemMaxBytes) || !filesystemStable(named, n.last) {
		return task.ErrUnknown
	}
	return nil
}
func (n *filesystemNative) Publish(data []byte) error {
	if len(data) == 0 || len(data) > filesystemMaxBytes || n.check() != nil || n.currentImage() != nil {
		return task.ErrUnknown
	}
	for _, name := range []string{filesystemPendingName, filesystemNextName} {
		found, err := n.exists(name)
		if err != nil || found {
			return task.ErrUnknown
		}
	}
	marker, err := n.writeNew(filesystemPendingName, []byte("TASK_JOURNAL_PUBLICATION_IN_PROGRESS_V1\n"))
	if err != nil || n.directory.Sync() != nil || n.check() != nil {
		return task.ErrUnknown
	}
	next, err := n.writeNew(filesystemNextName, data)
	if err != nil || n.check() != nil || n.currentImage() != nil {
		return task.ErrUnknown
	}
	// Rename publishes task/intent/receipt/result as one image, never a split
	// pair. File sync precedes it; directory sync confirms the published name.
	if unix.Renameat(int(n.directory.Fd()), filesystemNextName, int(n.directory.Fd()), filesystemImageName) != nil || n.directory.Sync() != nil || n.check() != nil {
		return task.ErrUnknown
	}
	var named unix.Stat_t
	if unix.Fstatat(int(n.directory.Fd()), filesystemPendingName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !filesystemStable(marker, named) {
		return task.ErrUnknown
	}
	if unix.Unlinkat(int(n.directory.Fd()), filesystemPendingName, 0) != nil || n.directory.Sync() != nil || n.check() != nil {
		return task.ErrUnknown
	}
	if unix.Fstatat(int(n.directory.Fd()), filesystemImageName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !n.privateFile(named, filesystemMaxBytes) || named.Dev != next.Dev || named.Ino != next.Ino || named.Size != next.Size {
		return task.ErrUnknown
	}
	n.last, n.hasLast = named, true
	return nil
}
func (n *filesystemNative) Close() error {
	if n.closed {
		return task.ErrUnavailable
	}
	n.closed = true
	var err error
	if n.lock != nil {
		err = n.lock.Close()
	}
	if n.directory != nil {
		if closeErr := n.directory.Close(); err == nil {
			err = closeErr
		}
	}
	// Closing the owned descriptor releases flock. The lock file and all
	// partial publication artifacts remain; no namespace recovery is attempted.
	if err != nil {
		return task.ErrUnknown
	}
	return nil
}

//go:build darwin

package mutation

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/legrch/farol/pkg/descriptor"
	"golang.org/x/sys/unix"
)

const writerName = ".mutation-writer.lock"

type pin struct {
	fd, parent int
	name       string
	initial    unix.Stat_t
}
type disk struct {
	pins         []pin
	root         Root
	dir, lock    int
	lockIdentity unix.Stat_t
}

func (d *disk) add(parent int, name string) error {
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return unavailable()
	}
	s, err := descriptor.Stat(fd)
	if err != nil || uint32(s.Mode)&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return unavailable()
	}
	d.pins = append(d.pins, pin{fd: fd, parent: parent, name: name, initial: s})
	return nil
}
func openNative(root Root) (storage, error) {
	return openNativeMode(root, true)
}

func openNativeMode(root Root, createWriter bool) (*disk, error) {
	if root.OwnerUID != uint32(os.Geteuid()) {
		return nil, unavailable()
	}
	d := &disk{root: root, dir: -1, lock: -1}
	fail := func() (*disk, error) { _ = d.close(); return nil, unavailable() }
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, unavailable()
	}
	s, err := descriptor.Stat(fd)
	if err != nil {
		_ = unix.Close(fd)
		return nil, unavailable()
	}
	d.pins = append(d.pins, pin{fd: fd, parent: -1, initial: s})
	for _, name := range strings.Split(strings.TrimPrefix(root.Path, "/"), "/") {
		if d.add(d.pins[len(d.pins)-1].fd, name) != nil {
			return fail()
		}
	}
	r := d.pins[len(d.pins)-1]
	if uint64(r.initial.Dev) != root.Device || r.initial.Ino != root.Inode || !descriptor.Private(r.initial, unix.S_IFDIR, 0700, root.OwnerUID) {
		return fail()
	}
	if d.add(r.fd, "mutations") != nil {
		return fail()
	}
	child := d.pins[len(d.pins)-1]
	if !descriptor.Private(child.initial, unix.S_IFDIR, 0700, root.OwnerUID) {
		return fail()
	}
	d.dir = child.fd
	// The root and child were independently qualified; only this retained writer
	// lock may be created. No state root/child/file is created, repaired or swept.
	flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	if createWriter {
		flags |= unix.O_RDWR | unix.O_CREAT
	}
	d.lock, err = unix.Openat(r.fd, writerName, flags, 0600)
	if err != nil {
		return fail()
	}
	d.lockIdentity, err = descriptor.Stat(d.lock)
	if err != nil || !descriptor.Private(d.lockIdentity, unix.S_IFREG, 0600, root.OwnerUID) || unix.Flock(d.lock, unix.LOCK_EX|unix.LOCK_NB) != nil || d.check() != nil {
		return fail()
	}
	return d, nil
}
func (d *disk) check() error {
	if d.dir < 0 || d.lock < 0 {
		return unavailable()
	}
	for _, p := range d.pins {
		current, err := descriptor.Stat(p.fd)
		if err != nil || !descriptor.Same(current, p.initial) || current.Mode != p.initial.Mode || current.Uid != p.initial.Uid {
			return unavailable()
		}
		if p.parent >= 0 {
			var named unix.Stat_t
			if unix.Fstatat(p.parent, p.name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !descriptor.Same(named, current) || named.Mode != current.Mode || named.Uid != current.Uid {
				return unavailable()
			}
		}
	}
	root := d.pins[len(d.pins)-2].fd
	current, err := descriptor.Stat(d.lock)
	var named unix.Stat_t
	if err != nil || !descriptor.Same(current, d.lockIdentity) || !descriptor.Private(current, unix.S_IFREG, 0600, d.root.OwnerUID) || unix.Fstatat(root, writerName, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !descriptor.Same(named, current) || !descriptor.Private(named, unix.S_IFREG, 0600, d.root.OwnerUID) {
		return unavailable()
	}
	return nil
}
func (d *disk) close() error {
	var err error
	if d.lock >= 0 {
		err = unix.Close(d.lock)
		d.lock = -1
	}
	for i := len(d.pins) - 1; i >= 0; i-- {
		err = errors.Join(err, unix.Close(d.pins[i].fd))
	}
	d.pins = nil
	d.dir = -1
	return err
}
func validKey(name string) bool {
	if len(name) != 69 || filepath.Base(name) != name || !strings.HasSuffix(name, ".json") {
		return false
	}
	for _, ch := range name[:64] {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}

// keys observes the complete bounded namespace while the original writer lock
// remains held. It never repairs or removes unexpected entries.
func (d *disk) keys() ([]string, error) {
	if d.check() != nil {
		return nil, unavailable()
	}
	fd, err := unix.Openat(d.dir, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, unavailable()
	}
	f := os.NewFile(uintptr(fd), "mutation-inventory")
	names, readErr := f.Readdirnames(maxSelfTestInventory + 1)
	extra, endErr := f.Readdirnames(1)
	closeErr := f.Close()
	if closeErr != nil || readErr != nil && readErr != io.EOF || endErr != io.EOF || len(extra) != 0 || len(names) > maxSelfTestInventory || d.check() != nil {
		return nil, unavailable()
	}
	sort.Strings(names)
	for i, name := range names {
		if !validKey(name) || i > 0 && name == names[i-1] {
			return nil, unavailable()
		}
	}
	return names, nil
}
func (d *disk) read(key string) ([]byte, error) {
	if !validKey(key) || d.check() != nil {
		return nil, unavailable()
	}
	fd, err := unix.Openat(d.dir, key, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) && d.check() == nil {
			return nil, nil
		}
		return nil, unavailable()
	}
	f := os.NewFile(uintptr(fd), key)
	before, err := descriptor.Stat(fd)
	if err != nil || !descriptor.Private(before, unix.S_IFREG, 0600, d.root.OwnerUID) || before.Size < 1 || before.Size > maxRecordBytes {
		_ = f.Close()
		return nil, unavailable()
	}
	raw, readErr := io.ReadAll(io.LimitReader(f, maxRecordBytes+1))
	after, statErr := descriptor.Stat(fd)
	var named unix.Stat_t
	nameErr := unix.Fstatat(d.dir, key, &named, unix.AT_SYMLINK_NOFOLLOW)
	closeErr := f.Close()
	if readErr != nil || statErr != nil || nameErr != nil || closeErr != nil || len(raw) != int(before.Size) || !descriptor.Stable(before, after) || !descriptor.Stable(after, named) || d.check() != nil {
		return nil, unavailable()
	}
	return raw, nil
}

type staged struct {
	name    string
	version unix.Stat_t
}

func (d *disk) stage(key string, raw []byte) (staged, error) {
	if !validKey(key) || len(raw) == 0 || len(raw) > maxRecordBytes || d.check() != nil {
		return staged{}, unavailable()
	}
	name, err := descriptor.Name("."+key+".tmp-", 8, "")
	if err != nil {
		return staged{}, unavailable()
	}
	fd, err := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return staged{}, unavailable()
	}
	f := os.NewFile(uintptr(fd), name)
	count, writeErr := f.Write(raw)
	syncErr := f.Sync()
	s, statErr := descriptor.Stat(fd)
	closeErr := f.Close()
	// An uncertain attempt retains its staging; no additional cleanup/undo pass.
	if writeErr != nil || count != len(raw) || syncErr != nil || statErr != nil || closeErr != nil || !descriptor.Private(s, unix.S_IFREG, 0600, d.root.OwnerUID) || s.Size != int64(len(raw)) || d.check() != nil {
		return staged{}, unknown()
	}
	return staged{name: name, version: s}, nil
}
func (d *disk) checkStage(s staged) error {
	var named unix.Stat_t
	if unix.Fstatat(d.dir, s.name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !descriptor.Stable(s.version, named) || !descriptor.Private(named, unix.S_IFREG, 0600, d.root.OwnerUID) {
		return unknown()
	}
	return nil
}
func (d *disk) removeStage(s staged, links uint16) error {
	if d.check() != nil {
		return unknown()
	}
	var named unix.Stat_t
	if unix.Fstatat(d.dir, s.name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !descriptor.Same(s.version, named) || named.Mode != s.version.Mode || named.Uid != s.version.Uid || named.Size != s.version.Size || named.Mtim != s.version.Mtim || named.Nlink != links {
		return unknown()
	}
	if unix.Unlinkat(d.dir, s.name, 0) != nil {
		return unknown()
	}
	return nil
}
func (d *disk) create(key string, raw []byte) error {
	s, err := d.stage(key, raw)
	if err != nil {
		return err
	}
	if d.check() != nil || d.checkStage(s) != nil {
		return unknown()
	}
	if err = unix.Linkat(d.dir, s.name, d.dir, key, 0); err != nil {
		if errors.Is(err, unix.EEXIST) {
			if d.removeStage(s, 1) != nil || unix.Fsync(d.dir) != nil || d.check() != nil {
				return unknown()
			}
			return errExists
		}
		return unknown()
	}
	// Both links must still refer to exactly this attempt's owned inode.
	var named unix.Stat_t
	if unix.Fstatat(d.dir, key, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !descriptor.Same(s.version, named) || named.Nlink != 2 || d.removeStage(s, 2) != nil || unix.Fsync(d.dir) != nil || d.check() != nil {
		return unknown()
	}
	observed, err := d.read(key)
	if err != nil || !bytes.Equal(observed, raw) {
		return unknown()
	}
	return nil
}
func (d *disk) replace(key string, raw, previous []byte) error {
	s, err := d.stage(key, raw)
	if err != nil {
		return err
	}
	observed, err := d.read(key)
	if err != nil || !bytes.Equal(observed, previous) || d.check() != nil || d.checkStage(s) != nil {
		return unknown()
	}
	// One ordinary private-journal publication under the retained exclusive writer;
	// this is not workspace hash CAS and not protection against same-user attackers.
	if unix.Renameat(d.dir, s.name, d.dir, key) != nil || unix.Fsync(d.dir) != nil || d.check() != nil {
		return unknown()
	}
	observed, err = d.read(key)
	if err != nil || !bytes.Equal(observed, raw) {
		return unknown()
	}
	return nil
}

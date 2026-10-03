//go:build darwin

package migration

import (
	"errors"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/legrch/farol/modules/release/domain/migration"
	"golang.org/x/sys/unix"
)

type ancestor struct {
	fd     int
	name   string
	object migration.Object
}

type directory struct {
	fd        int
	object    migration.Object
	ancestors []ancestor
}

func object(stat *unix.Stat_t) migration.Object {
	return migration.Object{Device: strconv.FormatInt(int64(stat.Dev), 10), File: strconv.FormatUint(stat.Ino, 10)}
}

func safeDirectory(stat *unix.Stat_t, final bool) bool {
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return false
	}
	uid := uint32(unix.Geteuid())
	if final {
		return stat.Uid == uid && stat.Mode&0022 == 0
	}
	if stat.Uid != 0 && stat.Uid != uid {
		return false
	}
	// Root-owned sticky temporary ancestors are safe namespaces for a separately
	// owner-protected final fixture root. Arbitrary shared writable paths refuse.
	return stat.Mode&0022 == 0 || (stat.Uid == 0 && stat.Mode&unix.S_ISVTX != 0)
}

func openDirectory(path string) (*directory, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.IndexByte(path, 0) >= 0 || path == "/" {
		return nil, refusal("MIGRATION_PARENT_INVALID")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, migration.ObservationUnknown
	}
	d := &directory{fd: fd}
	fail := func(err error) (*directory, error) { _ = d.close(); return nil, err }
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || !safeDirectory(&stat, false) {
		return fail(migration.UnsafeEntry)
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, name := range parts {
		parent := d.fd
		child, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return fail(migration.UnsafeEntry)
		}
		d.ancestors = append(d.ancestors, ancestor{fd: parent, name: name})
		d.fd = child
		if err := unix.Fstat(child, &stat); err != nil {
			return fail(migration.ObservationUnknown)
		}
		if !safeDirectory(&stat, i == len(parts)-1) {
			return fail(migration.UnsafeEntry)
		}
		d.object = object(&stat)
		d.ancestors[len(d.ancestors)-1].object = d.object
	}
	if err := d.verify(); err != nil {
		return fail(err)
	}
	return d, nil
}

func (d *directory) verify() error {
	for i, a := range d.ancestors {
		var stat unix.Stat_t
		if err := unix.Fstatat(a.fd, a.name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return migration.ObservationUnknown
		}
		if object(&stat) != a.object || !safeDirectory(&stat, i == len(d.ancestors)-1) {
			return migration.UnsafeEntry
		}
	}
	return d.verifyObject(d.object)
}

func (d *directory) verifyObject(expected migration.Object) error {
	var stat unix.Stat_t
	if err := unix.Fstat(d.fd, &stat); err != nil {
		return migration.ObservationUnknown
	}
	if !safeDirectory(&stat, true) || object(&stat) != expected {
		return migration.UnsafeEntry
	}
	return nil
}

func (d *directory) inspect(name string) (entry, error) {
	var stat unix.Stat_t
	err := unix.Fstatat(d.fd, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return entry{}, nil
	}
	if err != nil {
		return entry{}, migration.ObservationUnknown
	}
	if !safeDirectory(&stat, true) {
		return entry{}, migration.UnsafeEntry
	}
	return entry{present: true, object: object(&stat)}, nil
}

func (d *directory) openChild(name string, expected migration.Object) (*directory, error) {
	fd, err := unix.Openat(d.fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, migration.UnsafeEntry
	}
	child := &directory{fd: fd, object: expected}
	if err := child.verifyObject(expected); err != nil {
		_ = child.close()
		return nil, err
	}
	return child, nil
}

func (d *directory) close() error {
	var result error
	if d.fd >= 0 {
		result = unix.Close(d.fd)
		d.fd = -1
	}
	for _, a := range d.ancestors {
		if err := unix.Close(a.fd); err != nil && result == nil {
			result = err
		}
	}
	d.ancestors = nil
	return result
}

func renameExclusive(parent int, source, destination string) error {
	// Never replace, exchange, copy, follow a link, or retry with weaker flags.
	return unix.RenameatxNp(parent, source, parent, destination, unix.RENAME_EXCL|unix.RENAME_NOFOLLOW_ANY)
}

func syncDirectory(fd int) error {
	if err := unix.Fsync(fd); err != nil {
		return err
	}
	// Unlike os.File.Sync, do not weaken unsupported full-sync to plain fsync.
	_, err := unix.FcntlInt(uintptr(fd), unix.F_FULLFSYNC, 0)
	return err
}

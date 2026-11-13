//go:build darwin || linux

package descriptor

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// Verbatim copies of the helpers this kit replaced (chat handoff, chat
// lifecycle, computer access, computer mutation on 5b490cdf). Every variant
// below must give the kit and the copy the same answer.
func referencePhysical(s unix.Stat_t, kind, mode, uid uint32) bool {
	return uint32(s.Mode)&unix.S_IFMT == kind && uint32(s.Mode)&07777 == mode && s.Uid == uid && (kind == unix.S_IFDIR || s.Nlink == 1)
}
func referenceSame(a, b unix.Stat_t) bool { return a.Dev == b.Dev && a.Ino == b.Ino }
func referenceStable(a, b unix.Stat_t) bool {
	return referenceSame(a, b) && a.Mode == b.Mode && a.Uid == b.Uid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func referenceStableState(a, b unix.Stat_t) bool {
	return referenceSame(a, b) && a.Mode == b.Mode && a.Size == b.Size && a.Uid == b.Uid && a.Nlink == b.Nlink && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func fixtureStat(t *testing.T) unix.Stat_t {
	t.Helper()
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	var s unix.Stat_t
	if err := unix.Lstat(path, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func variants(base unix.Stat_t) map[string]unix.Stat_t {
	out := map[string]unix.Stat_t{"base": base}
	edit := func(name string, change func(*unix.Stat_t)) {
		v := base
		change(&v)
		out[name] = v
	}
	edit("dev", func(s *unix.Stat_t) { s.Dev++ })
	edit("ino", func(s *unix.Stat_t) { s.Ino++ })
	edit("directory", func(s *unix.Stat_t) { s.Mode = s.Mode&^unix.S_IFMT | unix.S_IFDIR })
	edit("symlink", func(s *unix.Stat_t) { s.Mode = s.Mode&^unix.S_IFMT | unix.S_IFLNK })
	edit("fifo", func(s *unix.Stat_t) { s.Mode = s.Mode&^unix.S_IFMT | unix.S_IFIFO })
	edit("group-read", func(s *unix.Stat_t) { s.Mode |= 0040 })
	edit("setuid", func(s *unix.Stat_t) { s.Mode |= unix.S_ISUID })
	edit("sticky", func(s *unix.Stat_t) { s.Mode |= unix.S_ISVTX })
	edit("mode-0700", func(s *unix.Stat_t) { s.Mode = s.Mode&^07777 | 0700 })
	edit("uid", func(s *unix.Stat_t) { s.Uid++ })
	edit("gid", func(s *unix.Stat_t) { s.Gid++ })
	edit("no-link", func(s *unix.Stat_t) { s.Nlink = 0 })
	edit("two-links", func(s *unix.Stat_t) { s.Nlink = 2 })
	edit("size", func(s *unix.Stat_t) { s.Size++ })
	edit("mtime", func(s *unix.Stat_t) { s.Mtim.Nsec++ })
	edit("ctime", func(s *unix.Stat_t) { s.Ctim.Sec++ })
	edit("atime", func(s *unix.Stat_t) { s.Atim.Sec++ })
	edit("rdev", func(s *unix.Stat_t) { s.Rdev++ })
	edit("blocks", func(s *unix.Stat_t) { s.Blocks++ })
	return out
}

func TestIdentityMatchesReplacedHelpers(t *testing.T) {
	base := fixtureStat(t)
	all := variants(base)
	uids := []uint32{base.Uid, base.Uid + 1}
	kinds := []uint32{unix.S_IFREG, unix.S_IFDIR, unix.S_IFLNK}
	modes := []uint32{0600, 0700, 0640, 0600 | unix.S_ISUID}
	for name, v := range all {
		for _, kind := range kinds {
			for _, mode := range modes {
				for _, uid := range uids {
					if got, want := Private(v, kind, mode, uid), referencePhysical(v, kind, mode, uid); got != want {
						t.Errorf("Private %s kind=%o mode=%o uid=%d: %v, replaced helper %v", name, kind, mode, uid, got, want)
					}
				}
			}
		}
		for other, w := range all {
			if got, want := Same(v, w), referenceSame(v, w); got != want {
				t.Errorf("Same %s/%s: %v, replaced helper %v", name, other, got, want)
			}
			if got, want := Stable(v, w), referenceStable(v, w); got != want {
				t.Errorf("Stable %s/%s: %v, replaced helper %v", name, other, got, want)
			}
			if got, want := Stable(v, w), referenceStableState(v, w); got != want {
				t.Errorf("Stable %s/%s: %v, replaced stableState %v", name, other, got, want)
			}
		}
	}
}

func TestIdentityFieldTable(t *testing.T) {
	base := fixtureStat(t)
	uid := base.Uid
	if !Private(base, unix.S_IFREG, 0600, uid) {
		t.Fatal("a private regular file was refused")
	}
	// Each of these must break Private for a 0600 regular file of uid.
	for _, name := range []string{"directory", "symlink", "fifo", "group-read", "setuid", "sticky", "mode-0700", "uid", "no-link", "two-links"} {
		if Private(variants(base)[name], unix.S_IFREG, 0600, uid) {
			t.Errorf("Private accepted %s", name)
		}
	}
	dir := variants(base)["directory"]
	dir.Mode = dir.Mode&^07777 | 0700
	for _, links := range []uint64{0, 2, 7} {
		setLinks(&dir, links)
		if !Private(dir, unix.S_IFDIR, 0700, uid) {
			t.Errorf("a directory with %d links was refused", links)
		}
	}
	// Stable watches exactly these fields; Same only device and inode.
	watched := map[string]bool{"dev": true, "ino": true, "directory": true, "symlink": true, "fifo": true, "group-read": true, "setuid": true, "sticky": true, "mode-0700": true, "uid": true, "no-link": true, "two-links": true, "size": true, "mtime": true, "ctime": true}
	for name, v := range variants(base) {
		if Stable(base, v) == watched[name] {
			t.Errorf("Stable on %s: %v", name, Stable(base, v))
		}
		if Same(base, v) != (name != "dev" && name != "ino") {
			t.Errorf("Same on %s: %v", name, Same(base, v))
		}
	}
}

func setLinks(s *unix.Stat_t, links uint64) {
	s.Nlink = 0
	for range links {
		s.Nlink++
	}
}

func TestIdentityOnRealObjects(t *testing.T) {
	dir := t.TempDir()
	uid := uint32(os.Geteuid())
	path := filepath.Join(dir, "state")
	if err := os.WriteFile(path, []byte("one"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	held, err := Stat(int(file.Fd()))
	if err != nil || !Private(held, unix.S_IFREG, 0600, uid) || Private(held, unix.S_IFREG, 0600, uid+1) || Private(held, unix.S_IFDIR, 0600, uid) {
		t.Fatal("held private file", err)
	}
	var named unix.Stat_t
	if err := unix.Fstatat(int(mustOpenDirectory(t, dir)), "state", &named, unix.AT_SYMLINK_NOFOLLOW); err != nil || !Same(held, named) || !Stable(held, named) {
		t.Fatal("named entry is not the held file", err)
	}

	// A second link makes the same object non-private.
	if err := os.Link(path, filepath.Join(dir, "alias")); err != nil {
		t.Fatal(err)
	}
	linked, err := Stat(int(file.Fd()))
	if err != nil || Private(linked, unix.S_IFREG, 0600, uid) || !Same(held, linked) || Stable(held, linked) {
		t.Fatal("hard link was not detected", err)
	}
	if err := os.Remove(filepath.Join(dir, "alias")); err != nil {
		t.Fatal(err)
	}

	// A permission change is visible to Private and Stable.
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	widened, err := Stat(int(file.Fd()))
	if err != nil || Private(widened, unix.S_IFREG, 0600, uid) || Stable(held, widened) {
		t.Fatal("permission change was not detected", err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}

	// A write changes size; a swapped entry is a different object.
	if err := os.WriteFile(path, []byte("longer"), 0600); err != nil {
		t.Fatal(err)
	}
	written, err := Stat(int(file.Fd()))
	if err != nil || !Same(held, written) || Stable(held, written) {
		t.Fatal("write was not detected", err)
	}
	swap := filepath.Join(dir, "swap")
	if err := os.WriteFile(swap, []byte("one"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(swap, path); err != nil {
		t.Fatal(err)
	}
	var swapped unix.Stat_t
	if err := unix.Lstat(path, &swapped); err != nil || Same(held, swapped) {
		t.Fatal("swapped entry looked like the held file", err)
	}

	// A symlink to a private file is a symlink, never a private file.
	if err := os.Symlink(path, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	var link unix.Stat_t
	if err := unix.Lstat(filepath.Join(dir, "link"), &link); err != nil || Private(link, unix.S_IFREG, 0600, uid) {
		t.Fatal("symlink passed as a private file", err)
	}

	// A private directory passes with any link count.
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(sub, "child"), 0700); err != nil {
		t.Fatal(err)
	}
	directory, err := Stat(mustOpenDirectory(t, sub))
	if err != nil || !Private(directory, unix.S_IFDIR, 0700, uid) || Private(directory, unix.S_IFREG, 0700, uid) {
		t.Fatal("private directory", err)
	}
}

func TestStatClosedDescriptor(t *testing.T) {
	fd, err := unix.Open(t.TempDir(), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Close(fd); err != nil {
		t.Fatal(err)
	}
	if _, err := Stat(fd); err == nil {
		t.Fatal("a closed descriptor was stated")
	}
}

func mustOpenDirectory(t *testing.T, path string) int {
	t.Helper()
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(fd) })
	return fd
}

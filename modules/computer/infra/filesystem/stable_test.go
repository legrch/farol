//go:build darwin || linux

package filesystem

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestStableComparesIdentityAndChangeTimes(t *testing.T) {
	base := unix.Stat_t{Dev: 1, Ino: 2, Mode: unix.S_IFREG | 0o600, Size: 3}
	if !stable(base, base) {
		t.Fatal("identical stat records must be stable")
	}
	for name, mutate := range map[string]func(*unix.Stat_t){
		"device": func(s *unix.Stat_t) { s.Dev++ },
		"inode":  func(s *unix.Stat_t) { s.Ino++ },
		"mode":   func(s *unix.Stat_t) { s.Mode ^= 0o077 },
		"size":   func(s *unix.Stat_t) { s.Size++ },
		"mtime":  func(s *unix.Stat_t) { s.Mtim.Nsec++ },
		"ctime":  func(s *unix.Stat_t) { s.Ctim.Nsec++ },
	} {
		changed := base
		mutate(&changed)
		if stable(base, changed) {
			t.Fatalf("%s change must not be stable", name)
		}
	}
}

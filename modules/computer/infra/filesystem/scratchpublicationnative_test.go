//go:build darwin

package filesystem

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// Qualifies only the native primitive in this disposable local filesystem.
// It does not establish ownership against another process with the same UID.
func TestScratchExclusivePublicationNative(t *testing.T) {
	base := t.TempDir()
	stage, destination := filepath.Join(base, "stage"), filepath.Join(base, "destination")
	for _, p := range []string{stage, destination} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	stageFD, err := unix.Open(stage, flags, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(stageFD)
	destFD, err := unix.Open(destination, flags, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(destFD)
	if err := unix.Mkdirat(stageFD, "candidate", 0700); err != nil {
		t.Fatal(err)
	}
	candidateFD, err := unix.Openat(stageFD, "candidate", flags, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(candidateFD)
	var candidate, published unix.Stat_t
	if err := unix.Fstat(candidateFD, &candidate); err != nil {
		t.Fatal(err)
	}
	if err := unix.RenameatxNp(stageFD, "candidate", destFD, "leaf", unix.RENAME_EXCL|unix.RENAME_NOFOLLOW_ANY); err != nil {
		t.Fatal(err)
	}
	if err := unix.Fstatat(destFD, "leaf", &published, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		t.Fatal(err)
	}
	if candidate.Dev != published.Dev || candidate.Ino != published.Ino {
		t.Fatal("published directory differs from pinned candidate")
	}
	if err := unix.Mkdirat(stageFD, "second", 0700); err != nil {
		t.Fatal(err)
	}
	if err := unix.RenameatxNp(stageFD, "second", destFD, "leaf", unix.RENAME_EXCL|unix.RENAME_NOFOLLOW_ANY); !errors.Is(err, unix.EEXIST) {
		t.Fatalf("collision did not refuse: %v", err)
	}
	var after unix.Stat_t
	if err := unix.Fstatat(destFD, "leaf", &after, unix.AT_SYMLINK_NOFOLLOW); err != nil || after.Dev != candidate.Dev || after.Ino != candidate.Ino {
		t.Fatal("collision changed original", err)
	}
	if err := unix.Renameat(destFD, "leaf", destFD, "moved"); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkdirat(destFD, "leaf", 0700); err != nil {
		t.Fatal(err)
	}
	if err := unix.Fstatat(destFD, "leaf", &after, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		t.Fatal(err)
	}
	if after.Dev == candidate.Dev && after.Ino == candidate.Ino {
		t.Fatal("replacement not detectable against retained descriptor")
	}
}

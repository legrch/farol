//go:build darwin

package migration

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/domain/migration"
	"golang.org/x/sys/unix"
)

func TestNativeNoReplaceAtSyscallBoundary(t *testing.T) {
	parent, f, expected := fixture(t)
	calls := 0
	f.rename = func(fd int, from, to string) error {
		calls++
		// Controlled fixture competitor creates destination after preflight.
		if err := unix.Mkdirat(fd, to, 0700); err != nil {
			return err
		}
		return renameExclusive(fd, from, to)
	}
	if _, err := f.move(expected, admit); !possibleEffect(err) {
		t.Fatalf("native failure became replayable: %v", err)
	}
	if calls != 1 {
		t.Fatalf("native calls=%d", calls)
	}
	observed, err := f.observe()
	if err != nil || observed.source.object != expected || !observed.destination.present || observed.destination.object == expected {
		t.Fatalf("destination replaced: %+v, %v", observed, err)
	}
	if _, err := os.Stat(filepath.Join(parent, migration.AlphaDirectory)); err != nil {
		t.Fatal(err)
	}
}

func TestNativeDescriptorsAreCloseOnExecAndClosed(t *testing.T) {
	_, f, _ := fixture(t)
	fds := []int{f.root.fd}
	for _, a := range f.root.ancestors {
		fds = append(fds, a.fd)
	}
	for _, fd := range fds {
		flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		if err != nil || flags&unix.FD_CLOEXEC == 0 {
			t.Fatalf("descriptor leaks to child: flags=%d err=%v", flags, err)
		}
	}
	if err := f.close(); err != nil {
		t.Fatal(err)
	}
	for _, fd := range fds {
		var stat unix.Stat_t
		if err := unix.Fstat(fd, &stat); !errors.Is(err, unix.EBADF) {
			t.Fatalf("descriptor not closed: %v", err)
		}
	}
}

func TestNativeAncestorAndRootRefusal(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		parent, _, _ := fixture(t)
		link := filepath.Join(filepath.Dir(parent), filepath.Base(parent)+"-link")
		if err := os.Symlink(parent, link); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(link) })
		if f, err := openFilesystem(link); err == nil {
			_ = f.close()
			t.Fatal("symlink root admitted")
		}
	})
	t.Run("writable", func(t *testing.T) {
		parent, f, expected := fixture(t)
		if err := os.Chmod(filepath.Join(parent, migration.AlphaDirectory), 0770); err != nil {
			t.Fatal(err)
		}
		if _, err := f.move(expected, admit); err != migration.UnsafeEntry {
			t.Fatalf("shared writable profile admitted: %v", err)
		}
	})
	t.Run("parent-replaced", func(t *testing.T) {
		parent, f, expected := fixture(t)
		original := parent + "-original"
		if err := os.Rename(parent, original); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(original) })
		if err := os.Mkdir(parent, 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := f.move(expected, admit); err != migration.UnsafeEntry {
			t.Fatalf("replaced parent admitted: %v", err)
		}
	})
	t.Run("source-symlink", func(t *testing.T) {
		parent, f, expected := fixture(t)
		if err := os.Remove(filepath.Join(parent, migration.AlphaDirectory)); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("Farol Dev", filepath.Join(parent, migration.AlphaDirectory)); err != nil {
			t.Fatal(err)
		}
		if _, err := f.move(expected, admit); err != migration.UnsafeEntry {
			t.Fatalf("linked source admitted: %v", err)
		}
	})
}

// The lock below is a disposable admission fixture, not a second production
// lease engine or proof that all Chromium/backend descendants have stopped.
func TestNativeAdmissionRemainsHeldAfterFilesystemClose(t *testing.T) {
	parent, s, b, j, a := consumerFixture(t)
	lockPath := filepath.Join(parent, "synthetic-admission.lock")
	fd, err := unix.Open(lockPath, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(fd) })
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	var identity unix.Stat_t
	if err := unix.Fstat(fd, &identity); err != nil {
		t.Fatal(err)
	}
	a.check = func(port.MigrationRoots) error {
		var live unix.Stat_t
		if err := unix.Lstat(lockPath, &live); err != nil || object(&live) != object(&identity) {
			return migration.LeaseRequired
		}
		return nil
	}
	owned := acquired(t, s, b, j, a)
	childReceipt(t, lockPath, "blocked")
	if err := owned.Close(); err != nil {
		t.Fatal(err)
	}
	childReceipt(t, lockPath, "blocked")
	if err := unix.Flock(fd, unix.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	childReceipt(t, lockPath, "held")
}

func childReceipt(t *testing.T, path, want string) {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestNativeAdmissionGuardChild$")
	cmd.Env = []string{"FAROL_SYNTHETIC_GUARD_CHILD=1", "FAROL_SYNTHETIC_GUARD_PATH=" + path, "FAROL_SYNTHETIC_GUARD_EXPECT=" + want}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("guard child: %s %v", out, err)
	}
}

func TestNativeAdmissionGuardChild(t *testing.T) {
	if os.Getenv("FAROL_SYNTHETIC_GUARD_CHILD") != "1" {
		return
	}
	fd, err := unix.Open(os.Getenv("FAROL_SYNTHETIC_GUARD_PATH"), unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	if os.Getenv("FAROL_SYNTHETIC_GUARD_EXPECT") == "blocked" {
		if !errors.Is(err, unix.EWOULDBLOCK) {
			t.Fatalf("second process acquired admission: %v", err)
		}
	} else if err != nil {
		t.Fatalf("released admission unavailable: %v", err)
	}
}

func TestNoncooperativeSourceRaceRemainsUnknown(t *testing.T) {
	parent, f, expected := fixture(t)
	writeFixture(t, filepath.Join(parent, migration.AlphaDirectory), "retained", "original alpha")
	f.rename = func(fd int, from, to string) error {
		// Controlled same-user fixture writer ignores the claimed admission.
		// Darwin cannot atomically compare source inode at rename; exact readback
		// must detect the violation instead of accepting the replacement.
		if err := unix.Renameat(fd, from, fd, "original"); err != nil {
			return err
		}
		if err := unix.Mkdirat(fd, from, 0700); err != nil {
			return err
		}
		return renameExclusive(fd, from, to)
	}
	if _, err := f.move(expected, admit); !possibleEffect(err) {
		t.Fatalf("source race accepted: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(parent, "original", "retained"))
	if err != nil || string(data) != "original alpha" {
		t.Fatalf("fixture provenance lost: %q %v", data, err)
	}
}

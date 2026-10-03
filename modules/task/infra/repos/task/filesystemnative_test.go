//go:build darwin || linux

package task

// Native tests are opt-in for the canonical Lead resource lane. They exercise
// disposable local files only; even a PASS is not power-loss, provider/process,
// installed backend or live-task acceptance.
import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
	"golang.org/x/sys/unix"
)

var filesystemNativeEnabled = flag.Bool("task-journal-native", false, "Run Lead-reserved Task journal native filesystem tests")

func filesystemNativeRoot(t *testing.T) FilesystemRoot {
	t.Helper()
	if !*filesystemNativeEnabled {
		t.Skip("Native filesystem tests require a canonical Lead slot and -task-journal-native")
	}
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// testing.TempDir creates its per-test child with 0777 (subject to umask).
	// Boot supplies a private root; model that prerequisite explicitly instead
	// of weakening the production adapter's exact 0700 qualification.
	path = filepath.Join(path, "private-journal")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	var stat unix.Stat_t
	if err := unix.Lstat(path, &stat); err != nil {
		t.Fatal(err)
	}
	return FilesystemRoot{ProfileID: "dev", Path: path, Device: uint64(stat.Dev), Inode: uint64(stat.Ino)}
}
func filesystemNativeOpen(t *testing.T, root FilesystemRoot) *Filesystem {
	t.Helper()
	j, err := OpenFilesystem(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !j.closed {
			if err := j.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	return j
}
func TestFilesystemNativeRetainedRoundtripAndExclusiveLease(t *testing.T) {
	root := filesystemNativeRoot(t)
	j := filesystemNativeOpen(t, root)
	filesystemLaunch(t, j, task.Codex)
	final := filesystemComplete(t, j)
	if other, err := OpenFilesystem(root); other != nil || !errors.Is(err, task.ErrUnavailable) {
		t.Fatalf("second lease: %+v %v", other, err)
	}
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := filesystemNativeOpen(t, root)
	snap, err := reopened.Read(filesystemCtx, "task")
	if err != nil || snap.Task != final {
		t.Fatalf("snapshot: %+v %v", snap, err)
	}
	op, err := reopened.Lookup(filesystemCtx, "create")
	if err != nil || op.Receipt.Result != final.Result {
		t.Fatalf("receipt: %+v %v", op, err)
	}
	wrong := root
	wrong.ProfileID = "other-profile"
	// This owner remains leased. Independent wrong-profile proof follows close.
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	if other, err := OpenFilesystem(wrong); other != nil || err == nil {
		t.Fatalf("foreign profile adopted journal: %+v %v", other, err)
	}
}
func TestFilesystemNativePartialArtifactsFenceWritesKeepCanonicalResult(t *testing.T) {
	for _, entry := range []string{filesystemPendingName, filesystemNextName} {
		t.Run(entry, func(t *testing.T) {
			root := filesystemNativeRoot(t)
			j := filesystemNativeOpen(t, root)
			filesystemLaunch(t, j, task.Codex)
			filesystemComplete(t, j)
			if err := j.Close(); err != nil {
				t.Fatal(err)
			}
			// A fixture-created partial artifact tests inspection, not a real crash or
			// unknown-operation retry. No promotion/removal of that artifact is allowed.
			path := filepath.Join(root.Path, entry)
			if err := os.WriteFile(path, []byte("partial fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			readonly := filesystemNativeOpen(t, root)
			op, err := readonly.Lookup(filesystemCtx, "create")
			if err != nil || op.Receipt.Result != "retained first result" {
				t.Fatalf("retained result: %+v %v", op, err)
			}
			if _, err := readonly.Lookup(filesystemCtx, "missing"); !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			before, _ := readonly.Read(filesystemCtx, "task")
			if err := readonly.Invalidate(filesystemCtx, *before); !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "partial fixture" {
				t.Fatal("partial publication recovered or deleted")
			}
		})
	}
}
func TestFilesystemNativeMissingCanonicalCannotReset(t *testing.T) {
	root := filesystemNativeRoot(t)
	j := filesystemNativeOpen(t, root)
	filesystemLaunch(t, j, task.Codex)
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(root.Path, filesystemImageName)
	if err := os.Remove(image); err != nil {
		t.Fatal(err)
	}
	if other, err := OpenFilesystem(root); other != nil || !errors.Is(err, task.ErrUnknown) {
		t.Fatalf("missing canonical reset: %+v %v", other, err)
	}
	if _, err := os.Lstat(image); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing image recreated")
	}
}
func TestFilesystemNativeUnsafeEntriesAreNonblockingAndUnmodified(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "fifo", "mode", "partial-json"} {
		t.Run(kind, func(t *testing.T) {
			root := filesystemNativeRoot(t)
			j := filesystemNativeOpen(t, root)
			if err := j.Close(); err != nil {
				t.Fatal(err)
			}
			image := filepath.Join(root.Path, filesystemImageName)
			switch kind {
			case "symlink":
				target := filepath.Join(t.TempDir(), "owned-target")
				if err := os.Rename(image, target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, image); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(image, filepath.Join(t.TempDir(), "owned-alias")); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := os.Remove(image); err != nil {
					t.Fatal(err)
				}
				if err := unix.Mkfifo(image, 0600); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(image, 0644); err != nil {
					t.Fatal(err)
				}
			case "partial-json":
				if err := os.WriteFile(image, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if other, err := OpenFilesystem(root); other != nil || err == nil {
				t.Fatalf("unsafe entry adopted: %+v %v", other, err)
			}
			info, err := os.Lstat(image)
			if err != nil {
				t.Fatal("unsafe evidence deleted")
			}
			if kind == "symlink" && info.Mode()&os.ModeSymlink == 0 || kind == "fifo" && info.Mode()&os.ModeNamedPipe == 0 || kind == "mode" && info.Mode().Perm() != 0644 {
				t.Fatal("unsafe entry repaired")
			}
		})
	}
}
func TestFilesystemNativeApprovedIdentityAndPrivateDirectory(t *testing.T) {
	for _, kind := range []string{"identity", "mode", "unexpected-entry"} {
		t.Run(kind, func(t *testing.T) {
			root := filesystemNativeRoot(t)
			switch kind {
			case "identity":
				root.Inode++
			case "mode":
				if err := os.Chmod(root.Path, 0755); err != nil {
					t.Fatal(err)
				}
			case "unexpected-entry":
				if err := os.WriteFile(filepath.Join(root.Path, "unowned"), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if j, err := OpenFilesystem(root); j != nil || err == nil {
				t.Fatalf("unapproved root opened: %+v %v", j, err)
			}
			if _, err := os.Lstat(filepath.Join(root.Path, filesystemImageName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("unapproved root mutated")
			}
		})
	}
}

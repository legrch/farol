//go:build darwin

package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Native disposable filesystem measurements only. The executable-shaped fixture
// is arbitrary text and is never executed; no anchor, sandbox or child is started.
func measurementFixture(t *testing.T) (Command, *confinedLaunch) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	identity := func(path string) authority.RootIdentity {
		t.Helper()
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		stat := info.Sys().(*syscall.Stat_t)
		return authority.RootIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10)}
	}
	root, scratch := filepath.Join(base, "root"), filepath.Join(base, "scratch")
	for _, path := range []string{root, scratch} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	image := filepath.Join(base, "image")
	contents := []byte("synthetic measurement only; never execute\n")
	if err := os.WriteFile(image, contents, 0500); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	command := Command{Root: root, Cwd: root, RootIdentity: identity(root)}
	launch := &confinedLaunch{scratch: scratch, scratchIdentity: identity(scratch), pins: []ExecutablePin{{Path: image, SHA256: hex.EncodeToString(digest[:])}}}
	return command, launch
}

// Real disposable filesystem drift between capture and release; the synthetic
// image is text, never executed. No sandbox/process qualification is inferred.
func TestNativeRetainedMeasurementRejectsBetweenCheckDrift(t *testing.T) {
	for _, mode := range []string{"current", "root-replaced", "scratch-mode", "image-replaced", "image-bytes"} {
		t.Run(mode, func(t *testing.T) {
			command, launch := measurementFixture(t)
			measurement, err := retainLaunch(context.Background(), command, launch)
			if err != nil {
				t.Fatal(err)
			}
			defer measurement.Close()
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "root-replaced":
				must(os.Rename(command.Root, command.Root+"-original"))
				must(os.Mkdir(command.Root, 0700))
			case "scratch-mode":
				must(os.Chmod(launch.scratch, 0755))
			case "image-replaced":
				path := launch.pins[0].Path
				data, err := os.ReadFile(path)
				must(err)
				must(os.Rename(path, path+"-original"))
				must(os.WriteFile(path, data, 0500))
			case "image-bytes":
				path := launch.pins[0].Path
				info, err := os.Stat(path)
				must(err)
				data, err := os.ReadFile(path)
				must(err)
				data[0] ^= 1
				must(os.Chmod(path, 0700))
				must(os.WriteFile(path, data, 0700))
				must(os.Chmod(path, 0500))
				must(os.Chtimes(path, info.ModTime(), info.ModTime()))
			}
			err = measurement.Recheck(context.Background())
			if mode == "current" {
				if err != nil {
					t.Fatal("unchanged retained filesystem refused", err)
				}
			} else {
				if err == nil {
					t.Fatal("changed original filesystem accepted")
				}
				if measurement.Recheck(context.Background()) == nil {
					t.Fatal("failed measurement resurrected")
				}
			}
		})
	}
}

func TestNativeProcessMeasurementRefusesChangedPhysicalInputs(t *testing.T) {
	for _, mode := range []string{"current", "root-identity", "root-link", "cwd-link", "scratch-identity", "scratch-mode", "scratch-link", "image-digest", "image-link", "image-hardlink", "image-writable", "image-not-executable", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			command, launch := measurementFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			link := func(target string) string {
				path := filepath.Join(filepath.Dir(command.Root), "alias")
				must(os.Symlink(target, path))
				return path
			}
			switch mode {
			case "root-identity":
				command.RootIdentity.Inode = "0"
			case "root-link":
				command.Root = link(command.Root)
			case "cwd-link":
				command.Cwd = link(command.Cwd)
			case "scratch-identity":
				launch.scratchIdentity.Inode = "0"
			case "scratch-mode":
				must(os.Chmod(launch.scratch, 0755))
			case "scratch-link":
				launch.scratch = link(launch.scratch)
			case "image-digest":
				launch.pins[0].SHA256 = strings.Repeat("0", 64)
			case "image-link":
				launch.pins[0].Path = link(launch.pins[0].Path)
			case "image-hardlink":
				must(os.Link(launch.pins[0].Path, filepath.Join(filepath.Dir(command.Root), "second-image")))
			case "image-writable":
				must(os.Chmod(launch.pins[0].Path, 0520))
			case "image-not-executable":
				must(os.Chmod(launch.pins[0].Path, 0400))
			case "cancelled":
				cancel()
			}
			close, err := measureLaunch(ctx, command, launch)
			if close != nil {
				defer close()
			}
			if mode == "current" {
				if err != nil || close == nil {
					t.Fatal("current measured fixture refused", err)
				}
			} else if err == nil || close != nil {
				t.Fatal("invalid measurement retained a launch permit", err)
			}
		})
	}
}

func TestNativeProcessMeasurementRetainsAndClosesEveryPin(t *testing.T) {
	for _, failSecond := range []bool{false, true} {
		t.Run(strconv.FormatBool(failSecond), func(t *testing.T) {
			command, launch := measurementFixture(t)
			first := launch.pins[0]
			second := first
			second.Path += "-second"
			data, err := os.ReadFile(first.Path)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(second.Path, data, 0500); err != nil {
				t.Fatal(err)
			}
			launch.pins = append(launch.pins, second)
			// Inspect only this test process's FDs and count exact synthetic inodes;
			// no numeric process lookup, signal or descriptor ownership transfer.
			openCount := func(path string) int {
				t.Helper()
				var target syscall.Stat_t
				if err := syscall.Lstat(path, &target); err != nil {
					t.Fatal(err)
				}
				listing, err := os.Open("/dev/fd")
				if err != nil {
					t.Fatal(err)
				}
				// Darwin /dev/fd entries need only their numeric names. ReadDir may
				// attempt fstatat on this special directory and return EBADF.
				names, err := listing.Readdirnames(-1)
				closeErr := listing.Close()
				if err != nil || closeErr != nil {
					t.Fatal("descriptor names unavailable", err, closeErr)
				}
				count := 0
				for _, name := range names {
					fd, err := strconv.Atoi(name)
					if err != nil || fd < 0 {
						continue
					}
					var held syscall.Stat_t
					if syscall.Fstat(fd, &held) == nil && held.Dev == target.Dev && held.Ino == target.Ino {
						count++
					}
				}
				return count
			}
			if openCount(first.Path) != 0 || openCount(second.Path) != 0 {
				t.Fatal("fixture image already open")
			}
			if failSecond {
				launch.pins[1].SHA256 = strings.Repeat("0", 64)
			}
			close, err := measureLaunch(context.Background(), command, launch)
			if failSecond {
				if close != nil {
					close()
					t.Fatal("failed measurement returned a retained closer")
				}
				if err == nil || openCount(first.Path) != 0 || openCount(second.Path) != 0 {
					t.Fatal("partial measurement leaked a descriptor", err)
				}
				return
			}
			if err != nil || close == nil {
				t.Fatal(err)
			}
			if openCount(first.Path) != 1 || openCount(second.Path) != 1 {
				close()
				t.Fatal("successful measurement did not retain every pin")
			}
			close()
			if openCount(first.Path) != 0 || openCount(second.Path) != 0 {
				t.Fatal("measurement closer leaked a descriptor")
			}
		})
	}
}

//go:build darwin

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Disposable native filesystem regression only: no child or sandbox dispatch.
func TestNativeProcessImageFIFORefusesWithoutWriter(t *testing.T) {
	for _, mode := range []string{"selected-image", "additional-protected-image", "watchdog-image"} {
		t.Run(mode, func(t *testing.T) {
			command, launch := measurementFixture(t)
			fifo := filepath.Join(filepath.Dir(command.Root), "fifo-image")
			if err := syscall.Mkfifo(fifo, 0700); err != nil {
				t.Fatal(err)
			}
			pin := ExecutablePin{fifo, strings.Repeat("a", 64)}
			if mode == "selected-image" {
				launch.pins[0] = pin
			} else {
				launch.pins = append(launch.pins, pin)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			type result struct {
				accepted bool
				err      error
			}
			done := make(chan result, 1)
			go func() {
				if mode == "watchdog-image" {
					held, err := pinnedExecutable(pin)
					if held != nil {
						held.Close()
					}
					done <- result{held != nil, err}
					return
				}
				held, err := retainLaunch(ctx, command, launch)
				if held != nil {
					held.Close()
				}
				done <- result{held != nil, err}
			}()
			select {
			case out := <-done:
				if out.err == nil || out.accepted {
					t.Fatal("FIFO image accepted")
				}
			case <-time.After(500 * time.Millisecond):
				// Unblock exactly this test-owned FIFO so the failed regression leaves no
				// stuck goroutine or descriptors. This is cleanup, not another measurement.
				peer, err := os.OpenFile(fifo, os.O_RDWR|syscall.O_NONBLOCK, 0)
				if err != nil {
					t.Fatal("cannot release original blocked FIFO", err)
				}
				defer peer.Close()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("original FIFO measurement remains blocked")
				}
				t.Fatal("image open blocked past its context deadline waiting for a FIFO writer")
			}
		})
	}
}

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

// This is a native pathname admission check, not sandbox execution evidence.
// Both spellings identify the same synthetic inode; only the kernel pathname
// may supply a profile grant. No child or executable fixture is started.
func TestNativePlatformCanonicalNamesRefuseAPFSAliases(t *testing.T) {
	command, launch := measurementFixture(t)
	ctx := context.Background()
	for _, path := range []string{command.Root, launch.pins[0].Path} {
		original, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		alias, err := os.Stat(dataVolumePath + path)
		if err != nil {
			t.Fatal("APFS alias fixture unavailable", err)
		}
		if !os.SameFile(original, alias) {
			t.Fatal("APFS spellings identify different inodes")
		}
	}
	for _, alias := range []bool{false, true} {
		pin := launch.pins[0]
		root := command.Root
		if alias {
			pin.Path = dataVolumePath + pin.Path
			root = dataVolumePath + root
		}
		held, err := (darwinLaunchFilesystem{}).pinExecutable(ctx, pin)
		if held != nil {
			if closeErr := held.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
		}
		if (err != nil) != alias {
			t.Fatalf("measurement alias=%v: %v", alias, err)
		}
		file, err := pinnedExecutable(pin)
		if file != nil {
			if closeErr := file.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
		}
		if (err != nil) != alias {
			t.Fatalf("watchdog pin alias=%v: %v", alias, err)
		}
		_, err = (nativePlatformFacts{}).directory(ctx, root)
		if (err != nil) != alias {
			t.Fatalf("platform directory alias=%v: %v", alias, err)
		}
	}
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

// Disposable native filesystem/descriptor tests only. Synthetic executable text
// is never launched. No sandbox, helper, native process or network is exercised.
func nativeBundleFixture(t *testing.T) (Command, *confinedLaunch) {
	t.Helper()
	command, launch := measurementFixture(t)
	path := filepath.Join(filepath.Dir(command.Root), "Farol.app")
	if err := os.Mkdir(path, 0755); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	st := info.Sys().(*syscall.Stat_t)
	launch.protectedBundle = &ProtectedBundle{path, authority.RootIdentity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}}
	return command, launch
}

func TestProtectedBundleNativeRetainedDirectoryIdentityAndReplacement(t *testing.T) {
	for _, mode := range []string{"current", "root-replaced", "ancestor-replaced", "symlink-replaced", "mode-drift", "safe-mode-drift", "sibling-write", "resource-bytes-limit"} {
		t.Run(mode, func(t *testing.T) {
			command, launch := nativeBundleFixture(t)
			bundle := *launch.protectedBundle
			measurement, err := retainLaunch(context.Background(), command, launch)
			if err != nil {
				t.Fatal(err)
			}
			defer measurement.Close()
			var held *darwinDirectoryPin
			for _, check := range measurement.directories {
				if check.path == bundle.Path {
					held = check.pin.(*darwinDirectoryPin)
				}
			}
			if held == nil {
				t.Fatal("bundle descriptor not retained by existing owner")
			}
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "root-replaced":
				must(os.Rename(bundle.Path, bundle.Path+"-old"))
				must(os.Mkdir(bundle.Path, 0755))
			case "ancestor-replaced":
				parent := filepath.Dir(bundle.Path)
				old := parent + "-old"
				must(os.Rename(parent, old))
				must(os.Mkdir(parent, 0700))
				// Keep the original bundle inode reachable at the same path while replacing
				// its enclosing directory; existing root/scratch pins must still refuse.
				must(os.Rename(filepath.Join(old, filepath.Base(bundle.Path)), bundle.Path))
				t.Cleanup(func() { _ = os.RemoveAll(old) })
			case "symlink-replaced":
				must(os.Rename(bundle.Path, bundle.Path+"-old"))
				must(os.Symlink(bundle.Path+"-old", bundle.Path))
			case "mode-drift":
				must(os.Chmod(bundle.Path, 0775))
			case "safe-mode-drift":
				must(os.Chmod(bundle.Path, 0700))
			case "sibling-write":
				must(os.WriteFile(filepath.Join(filepath.Dir(bundle.Path), "ordinary-sibling"), []byte("permitted fixture write"), 0600))
			case "resource-bytes-limit":
				// Explicit negative coverage: bundle identity is not dependency attestation.
				must(os.WriteFile(filepath.Join(bundle.Path, "resource.js"), []byte("mutable unpinned fixture bytes"), 0600))
			}
			err = measurement.Recheck(context.Background())
			accepted := mode == "current" || mode == "sibling-write" || mode == "resource-bytes-limit"
			if (err == nil) != accepted {
				t.Fatal("incorrect retained directory result", mode, err)
			}
			measurement.Close()
			measurement.Close()
			if _, err := held.Stat(); err == nil {
				t.Fatal("retained bundle descriptor leaked")
			}
			if measurement.Recheck(context.Background()) == nil {
				t.Fatal("measurement resurrected")
			}
		})
	}
}

func TestProtectedBundleNativeCanonicalAPFSAndSymlinkAdmission(t *testing.T) {
	_, launch := nativeBundleFixture(t)
	bundle := *launch.protectedBundle
	facts, err := (nativePlatformFacts{}).directory(context.Background(), bundle.Path)
	if err != nil || facts.path != bundle.Path || facts.identity != bundle.Identity || facts.filesystem != "apfs" || !facts.local || facts.nested {
		t.Fatal("disposable canonical APFS fixture refused", facts, err)
	}
	alias := dataVolumePath + bundle.Path
	before, err := os.Stat(bundle.Path)
	if err != nil {
		t.Fatal(err)
	}
	alternate, err := os.Stat(alias)
	if err != nil || !os.SameFile(before, alternate) {
		t.Fatal("APFS alternate spelling unavailable", err)
	}
	if _, err := (nativePlatformFacts{}).directory(context.Background(), alias); err == nil {
		t.Fatal("APFS noncanonical spelling accepted")
	}
	link := bundle.Path + "-alias"
	if err := os.Symlink(bundle.Path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := (nativePlatformFacts{}).directory(context.Background(), link); err == nil {
		t.Fatal("symlink bundle accepted")
	}
}

func TestProtectedBundleNativeInvalidIdentityAndPartialCapture(t *testing.T) {
	command, launch := nativeBundleFixture(t)
	launch.protectedBundle.Identity.Inode = "0"
	if held, err := retainLaunch(context.Background(), command, launch); err == nil || held != nil {
		if held != nil {
			held.Close()
		}
		t.Fatal("invalid directory identity admitted")
	}
	command, launch = nativeBundleFixture(t)
	launch.protectedBundle.Identity.Inode = "1"
	if held, err := retainLaunch(context.Background(), command, launch); err == nil || held != nil {
		if held != nil {
			held.Close()
		}
		t.Fatal("wrong bundle inode admitted")
	}
}

// State is private and stays bound to its retained identity across preparation.
// These are descriptor tests; no process is launched.
func TestProtectedStateNativeRetainedDirectoryReplacement(t *testing.T) {
	for _, mode := range []string{"current", "replacement", "mode-drift", "initial-public"} {
		t.Run(mode, func(t *testing.T) {
			command, launch := nativeBundleFixture(t)
			launch.protectedState, launch.protectedBundle = launch.protectedBundle, nil
			state := *launch.protectedState
			if err := os.Chmod(state.Path, 0700); err != nil {
				t.Fatal(err)
			}
			if mode == "initial-public" {
				if err := os.Chmod(state.Path, 0755); err != nil {
					t.Fatal(err)
				}
			}
			measurement, err := retainLaunch(context.Background(), command, launch)
			if mode == "initial-public" {
				if err == nil || measurement != nil {
					if measurement != nil {
						measurement.Close()
					}
					t.Fatal("nonprivate state admitted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer measurement.Close()
			switch mode {
			case "replacement":
				if err := os.Rename(state.Path, state.Path+"-old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(state.Path, 0700); err != nil {
					t.Fatal(err)
				}
			case "mode-drift":
				if err := os.Chmod(state.Path, 0755); err != nil {
					t.Fatal(err)
				}
			}
			err = measurement.Recheck(context.Background())
			if (err == nil) != (mode == "current") {
				t.Fatal("incorrect state recheck", mode, err)
			}
		})
	}
}

// CPU doubles only, including the Darwin descriptor verifier below. These tests
// open no files, launch no commands, and prove no native/platform enforcement.
func retainedMeasurementFixture(t *testing.T, ctx context.Context) (*retainedLaunchMeasurement, Command, *confinedLaunch, *measurementFilesystemDouble) {
	t.Helper()
	_, command, launch, fs := rootMeasurementFixture(t)
	path := "/approved/git/common/metadata"
	identity := authority.RootIdentity{Device: "1", Inode: "91"}
	launch.gitDirectories = append(launch.gitDirectories, gitReadDirectory{"/approved/git", path, identity})
	fs.directories[path] = directoryFacts{identity, os.ModeDir | 0700, 501}
	m, err := retainLaunchFiles(ctx, command, launch, fs)
	if err != nil || m == nil {
		t.Fatal("initial retained measurement failed", err)
	}
	t.Cleanup(m.Close)
	return m, command, launch, fs
}
func assertMeasurementRefused(t *testing.T, err error) {
	t.Helper()
	var failure *processsvc.NativeFailure
	if !errors.As(err, &failure) || failure.Unknown {
		t.Fatalf("expected known pre-dispatch refusal, got %v", err)
	}
}

func TestRetainedMeasurementSameHandlesAndFrozenSelection(t *testing.T) {
	m, command, launch, fs := retainedMeasurementFixture(t, context.Background())
	handles := append([]*measurementHandleDouble(nil), fs.handles...)
	absolute := append([]string(nil), fs.absolute...)
	anchored := append([][2]string(nil), fs.anchored...)
	// Caller mutation cannot replace the identities/paths already captured.
	command.Root, command.Cwd = "/foreign", "/foreign"
	launch.scratch, launch.scratchIdentity.Inode = "/foreign", "changed"
	launch.roots[0].ScopeRoot = "/foreign"
	launch.pins[0] = ExecutablePin{"/foreign", "changed"}
	for i := 0; i < 2; i++ {
		if err := m.Recheck(context.Background()); err != nil {
			t.Fatal(err)
		}
		fs.assertCloses(t, 0)
	}
	if !reflect.DeepEqual(handles, fs.handles) || !reflect.DeepEqual(absolute, fs.absolute) || !reflect.DeepEqual(anchored, fs.anchored) {
		t.Fatal("recheck reopened or replaced a descriptor")
	}
	for _, pin := range m.executables {
		if pin.(*measurementExecutableDouble).checks != 3 {
			t.Fatal("initial/final executable rechecks missing")
		}
	}
	m.Close()
	m.Close()
	fs.assertCloses(t, 1)
	assertMeasurementRefused(t, m.Recheck(context.Background()))
	fs.assertCloses(t, 1)
}

func TestRetainedMeasurementBetweenChecksDirectoryDrift(t *testing.T) {
	for _, target := range []string{"root", "cwd", "scratch", "approved", "scope", "git-directory"} {
		for _, drift := range []string{"device", "inode", "alias", "missing", "not-directory", "symlink", "resolve-error"} {
			t.Run(target+"/"+drift, func(t *testing.T) {
				m, command, launch, fs := retainedMeasurementFixture(t, context.Background())
				paths := map[string]string{"root": command.Root, "cwd": command.Cwd, "scratch": launch.scratch,
					"approved": "/approved/git", "scope": "/approved/git/common", "git-directory": "/approved/git/common/metadata"}
				path := paths[target]
				beforeOpens := len(fs.handles)
				facts := fs.directories[path]
				switch drift {
				case "device":
					facts.identity.Device = "2"
				case "inode":
					facts.identity.Inode = "replacement"
				case "alias":
					fs.alias = path
				case "missing":
					delete(fs.directories, path)
				case "not-directory":
					facts.mode = 0700
				case "symlink":
					facts.mode |= os.ModeSymlink
				case "resolve-error":
					fs.resolveError = path
				}
				if drift != "missing" {
					fs.directories[path] = facts
				}
				assertMeasurementRefused(t, m.Recheck(context.Background()))
				fs.assertCloses(t, 1)
				// Restoration does not resurrect or swap the consumed measurement.
				facts.identity.Inode = "restored"
				fs.directories[path] = facts
				assertMeasurementRefused(t, m.Recheck(context.Background()))
				if len(fs.handles) != beforeOpens {
					t.Fatal("refusal reopened handles")
				}
				fs.assertCloses(t, 1)
			})
		}
	}
}

func TestRetainedMeasurementScratchOwnerAndModeDrift(t *testing.T) {
	for _, drift := range []string{"owner", "mode"} {
		t.Run(drift, func(t *testing.T) {
			m, _, launch, fs := retainedMeasurementFixture(t, context.Background())
			facts := fs.directories[launch.scratch]
			if drift == "owner" {
				facts.uid++
			} else {
				facts.mode = os.ModeDir | 0755
			}
			fs.directories[launch.scratch] = facts
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			fs.assertCloses(t, 1)
		})
	}
}

func TestRetainedMeasurementExecutableFailureClosesEverything(t *testing.T) {
	_, _, launch, _ := rootMeasurementFixture(t)
	for i := range launch.pins {
		t.Run(launch.pins[i].Path, func(t *testing.T) {
			m, _, _, fs := retainedMeasurementFixture(t, context.Background())
			m.executables[i].(*measurementExecutableDouble).fail = true
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			fs.assertCloses(t, 1)
		})
	}
}

func TestRetainedMeasurementCancellationConsumesOriginalLifetime(t *testing.T) {
	for _, mode := range []string{"nil", "caller-before", "caller-during-image", "original-before", "original-during-image", "during-directory", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			original, cancelOriginal := context.WithCancel(context.Background())
			defer cancelOriginal()
			m, _, _, fs := retainedMeasurementFixture(t, original)
			caller, cancelCaller := context.WithCancel(context.Background())
			defer cancelCaller()
			switch mode {
			case "nil":
				caller = nil
			case "caller-before":
				cancelCaller()
			case "caller-during-image":
				m.executables[0].(*measurementExecutableDouble).before = func(context.Context) { cancelCaller() }
			case "original-before":
				cancelOriginal()
			case "original-during-image":
				m.executables[0].(*measurementExecutableDouble).before = func(context.Context) { cancelOriginal() }
			case "during-directory":
				fs.inspectHook = func(string) { cancelCaller() }
			case "deadline":
				caller, cancelCaller = context.WithDeadline(context.Background(), time.Unix(1, 0))
				defer cancelCaller()
			}
			assertMeasurementRefused(t, m.Recheck(caller))
			fs.assertCloses(t, 1)
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			fs.assertCloses(t, 1)
		})
	}
}

func TestRetainedMeasurementPartialCancellationAndCloseErrors(t *testing.T) {
	_, command, launch, fs := rootMeasurementFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fs.afterOpen = func(string) { cancel() }
	m, err := retainLaunchFiles(ctx, command, launch, fs)
	if m != nil {
		t.Fatal("partial cancelled measurement escaped")
	}
	assertMeasurementRefused(t, err)
	fs.assertCloses(t, 1)
	m, _, _, fs = retainedMeasurementFixture(t, context.Background())
	var order []int
	for i, h := range fs.handles {
		h.closeError = errors.New("synthetic close error")
		h.onClose = func() { order = append(order, i) }
	}
	m.Close()
	m.Close()
	fs.assertCloses(t, 1)
	for i, got := range order {
		if got != len(fs.handles)-1-i {
			t.Fatal("partial cleanup or wrong close order", order)
		}
	}
	var missing *retainedLaunchMeasurement
	missing.Close()
	assertMeasurementRefused(t, missing.Recheck(context.Background()))
}

func TestRetainedMeasurementCloserCompatibilityIsIdempotent(t *testing.T) {
	_, command, launch, fs := rootMeasurementFixture(t)
	close, err := measureLaunchFiles(context.Background(), command, launch, fs)
	if err != nil || close == nil {
		t.Fatal(err)
	}
	fs.assertCloses(t, 0)
	close()
	close()
	fs.assertCloses(t, 1)
}

// Immutable metadata snapshots implement os.FileInfo; neither Stat nor ReadAt
// invokes native APIs. The verifier compares Darwin device/inode stat values.
type retainedImageInfo struct {
	mode     os.FileMode
	size     int64
	modified time.Time
	stat     syscall.Stat_t
}

func (i retainedImageInfo) Name() string       { return "synthetic-image" }
func (i retainedImageInfo) Size() int64        { return i.size }
func (i retainedImageInfo) Mode() os.FileMode  { return i.mode }
func (i retainedImageInfo) ModTime() time.Time { return i.modified }
func (i retainedImageInfo) IsDir() bool        { return i.mode.IsDir() }
func (i retainedImageInfo) Sys() any           { stat := i.stat; return &stat }

type retainedImageFileDouble struct {
	data                 []byte
	info                 retainedImageInfo
	closes, stats, reads int
	statErrorAt          int
	readError            bool
	duringRead           func()
	offsets              []int64
}

func (f *retainedImageFileDouble) Close() error { f.closes++; return nil }
func (f *retainedImageFileDouble) Stat() (os.FileInfo, error) {
	f.stats++
	if f.stats == f.statErrorAt {
		return nil, errors.New("synthetic stat error")
	}
	return f.info, nil
}
func (f *retainedImageFileDouble) ReadAt(b []byte, offset int64) (int, error) {
	f.reads++
	f.offsets = append(f.offsets, offset)
	if f.duringRead != nil {
		f.duringRead()
	}
	if f.readError {
		return 0, errors.New("synthetic read error")
	}
	return bytes.NewReader(f.data).ReadAt(b, offset)
}
func retainedImageFixture(t *testing.T) (*retainedLaunchMeasurement, *darwinExecutableMeasurement, *retainedImageFileDouble, *measurementFilesystemDouble) {
	t.Helper()
	_, command, launch, fs := rootMeasurementFixture(t)
	data := []byte("synthetic pinned image bytes")
	digest := sha256.Sum256(data)
	info := retainedImageInfo{mode: 0500, size: int64(len(data)), modified: time.Unix(1, 0), stat: syscall.Stat_t{Dev: 1, Ino: 2, Uid: 501, Nlink: 1}}
	file := &retainedImageFileDouble{data: data, info: info}
	pin := &darwinExecutableMeasurement{file: file, selected: ExecutablePin{"/synthetic/image", hex.EncodeToString(digest[:])}, original: info, ownerUID: 501}
	pin.named = func(path string) (os.FileInfo, error) {
		if path != pin.selected.Path {
			t.Fatal("named path changed")
		}
		return file.info, nil
	}
	m, err := retainLaunchFiles(context.Background(), command, launch, fs)
	if err != nil {
		t.Fatal(err)
	}
	// Attach the real verifier over CPU doubles; this seam performs no open.
	m.executables = append(m.executables, pin)
	m.pins = append(m.pins, pin)
	t.Cleanup(m.Close)
	if err := m.Recheck(context.Background()); err != nil {
		t.Fatal("synthetic original refused", err)
	}
	return m, pin, file, fs
}

func TestRetainedExecutableSameDescriptorHashAndOffset(t *testing.T) {
	m, pin, file, fs := retainedImageFixture(t)
	for i := 0; i < 2; i++ {
		if err := m.Recheck(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if pin.file != file || !reflect.DeepEqual(file.offsets, []int64{0, 0, 0}) || file.closes != 0 {
		t.Fatal("hash did not reuse the original descriptor at offset zero", file.offsets)
	}
	m.Close()
	m.Close()
	if file.closes != 1 {
		t.Fatal("retained image not closed exactly once")
	}
	fs.assertCloses(t, 1)
}

func TestRetainedExecutableBetweenChecksDriftAndErrors(t *testing.T) {
	for _, mode := range []string{"hash", "descriptor-device", "descriptor-inode", "named-inode", "named-symlink", "named-alias-error", "mode", "owner", "hardlink", "size", "mtime", "not-regular", "oversize", "stat-before", "stat-after", "read", "named", "during-hash", "cancel-read", "cancel-named"} {
		t.Run(mode, func(t *testing.T) {
			m, pin, file, fs := retainedImageFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "hash":
				file.data[0] ^= 1 // Same inode/size/mtime; digest still must fail.
			case "descriptor-device":
				file.info.stat.Dev++
			case "descriptor-inode":
				file.info.stat.Ino++
			case "named-inode", "named-symlink":
				named := file.info
				if mode == "named-inode" {
					named.stat.Ino++
				} else {
					named.mode |= os.ModeSymlink
				}
				pin.named = func(string) (os.FileInfo, error) { return named, nil }
			case "named-alias-error", "named":
				pin.named = func(string) (os.FileInfo, error) { return nil, errors.New("synthetic named path error") }
			case "mode":
				file.info.mode = 0520
			case "owner":
				file.info.stat.Uid++
			case "hardlink":
				file.info.stat.Nlink++
			case "size":
				file.info.size++
			case "mtime":
				file.info.modified = file.info.modified.Add(time.Second)
			case "not-regular":
				file.info.mode |= os.ModeDir
			case "oversize":
				file.info.size = 128*1024*1024 + 1
			case "stat-before":
				file.statErrorAt = file.stats + 1
			case "stat-after":
				file.statErrorAt = file.stats + 2
			case "read":
				file.readError = true
			case "during-hash":
				file.duringRead = func() { file.info.stat.Ino++ }
			case "cancel-read":
				file.duringRead = cancel
			case "cancel-named":
				pin.named = func(string) (os.FileInfo, error) { cancel(); return file.info, nil }
			}
			assertMeasurementRefused(t, m.Recheck(ctx))
			if file.closes != 1 {
				t.Fatal("image failure did not close retained descriptor")
			}
			fs.assertCloses(t, 1)
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			if file.closes != 1 {
				t.Fatal("failed image measurement resurrected")
			}
		})
	}
}

var _ io.ReaderAt = (*retainedImageFileDouble)(nil)

func TestRetainedMeasurementLateImageDriftRefusesInitialCapture(t *testing.T) {
	_, command, launch, fs := rootMeasurementFixture(t)
	fs.afterOpen = func(string) { fs.images[0].fail = true }
	m, err := retainLaunchFiles(context.Background(), command, launch, fs)
	if m != nil {
		t.Fatal("later directory measurement hid early image drift")
	}
	assertMeasurementRefused(t, err)
	fs.assertCloses(t, 1)
}

type hostRuntimeMeasurementFilesystemDouble struct {
	*measurementFilesystemDouble
	runtime *hostRuntimeFixtureFS
}

func (f *hostRuntimeMeasurementFilesystemDouble) checkHostRuntime(ctx context.Context, p *HostRuntimePlan) error {
	return p.recheck(ctx, f.runtime)
}
func TestRetainedInstalledRuntimeCannotRefreshOrRenewPreparation(t *testing.T) {
	for _, mode := range []string{"drift", "cancelled", "missing-reader"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime := runtimeFixture()
			p, err := buildRuntimeFixture(runtime)
			if err != nil {
				t.Fatal(err)
			}
			_, command, launch, base := rootMeasurementFixture(t)
			launch.hostRuntime = p
			var fs launchFilesystem = &hostRuntimeMeasurementFilesystemDouble{base, runtime}
			if mode == "missing-reader" {
				fs = base
			}
			m, err := retainLaunchFiles(ctx, command, launch, fs)
			if mode == "missing-reader" {
				if err == nil {
					m.Close()
					t.Fatal("unimplemented runtime fact reader accepted")
				}
				base.assertCloses(t, 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if m.Recheck(context.Background()) != nil {
				t.Fatal("initial immutable plan refused")
			}
			// A caller cannot swap the snapshot retained by this original invocation.
			p.frozen.ExecFiles = nil
			if mode == "drift" {
				n := runtime.nodes["/install/bin/git-real"]
				n.SHA256 = strings.Repeat("f", 64)
				runtime.nodes[n.Path] = n
			} else {
				cancel()
			}
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			base.assertCloses(t, 1)
		})
	}
}

func TestRetainedSystemRmHardlinksStillRejectDrift(t *testing.T) {
	m, pin, file, _ := retainedImageFixture(t)
	pin.selected.Path = "/bin/rm"
	file.info.stat.Uid = 0
	file.info.stat.Nlink = 2
	pin.original = file.info
	if err := m.Recheck(context.Background()); err != nil {
		t.Fatal("pinned system pair refused", err)
	}
	file.info.stat.Nlink = 1
	if err := m.Recheck(context.Background()); err == nil {
		t.Fatal("changed system link count accepted")
	}
}

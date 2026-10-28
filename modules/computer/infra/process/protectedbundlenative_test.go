//go:build darwin

package process

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

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

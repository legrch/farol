//go:build darwin

package execution

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
)

// This is an actual capture-owner filesystem witness in private disposable
// directories. Route/admission/lease remain symbolic; SharedParent selects
// capture policy only. It is explicitly NOT a shared /Applications CLI witness.
// No process is launched and every failed/unknown image namespace is retained.
func TestNativeHelperCapturePrivatePublication(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled native capture owner")
	}
	for _, fault := range []string{"none", "existing-image", "mismatched-target", "source-symlink"} {
		t.Run(fault, func(t *testing.T) {
			root, err := os.MkdirTemp("", "farol-helper-capture-")
			if err != nil {
				t.Fatal(err)
			}
			t.Log("RETAINED capture fixture:", root)
			f := newLifecycleFixtureAt(t, newCompositionFixtureAt(t, root, true))
			app := filepath.Join(f.config.Files.Applications.Name(), "Farol.app")
			if err := os.Rename(app, filepath.Join(root, "source-retained.app")); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(filepath.Join(root, "target.app"), app); err != nil {
				t.Fatal(err)
			}
			f.config.Files.SharedParent = true
			location := "shared"
			f.config.Request.InstallLocation = &location
			f.owner.request = f.config.Request
			f.put(t, f.encoded(t, "verified"))
			switch fault {
			case "existing-image":
				if err := os.Mkdir(filepath.Join(f.path, "launch-Farol.app"), 0700); err != nil {
					t.Fatal(err)
				}
			case "mismatched-target":
				if err := os.WriteFile(filepath.Join(app, "Contents/Info.plist"), []byte("corrupt"), 0600); err != nil {
					t.Fatal(err)
				}
			case "source-symlink":
				if err := os.Symlink("../../outside", filepath.Join(app, "unsafe")); err != nil {
					t.Fatal(err)
				}
			}
			var observed string
			var kept port.HelperRelaunchEffects
			err = withInstallation(context.Background(), f.config, func(context.Context) error { return nil }, func(native port.HelperInstallationRuntime) error {
				launch := native.(port.HelperRelaunchEffects)
				kept = launch
				path, err := launch.CapturePrivateTarget(context.Background())
				if fault != "none" {
					if err == nil || path != "" {
						t.Fatal("capture fault accepted", path, err)
					}
					return err
				}
				if err != nil {
					return err
				}
				observed = path
				return nil
			})
			if fault == "none" {
				if err != nil || observed == "" {
					t.Fatal("capture did not complete", err)
				}
				published := filepath.Join(f.path, "launch-Farol.app")
				if observed != published {
					t.Fatal("returned launch path does not name the actual published image", observed, published)
				}
				parent, appFile := lifecycleOpen(t, f.path), lifecycleOpen(t, published)
				b := f.config.Request.Target
				verifier, err := apptree.New(parent, appFile, "launch-Farol.app", apptree.Expected{TreeSHA256: b.Digest, Version: b.Version, BuildID: b.BuildID}, appidentity.Verify)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := verifier.Verify(context.Background()); err != nil {
					t.Fatal("published image failed independent verification", err)
				}
				if _, err := kept.CapturePrivateTarget(context.Background()); err == nil {
					t.Fatal("retained capture revived")
				}
			} else if err == nil {
				t.Fatal("unknown capture scope became clean")
			}
			if fault == "existing-image" {
				children, err := os.ReadDir(filepath.Join(f.path, "launch-Farol.app"))
				if err != nil || len(children) != 0 {
					t.Fatal("existing image replaced", err)
				}
			}
			if fault != "none" && fault != "existing-image" {
				if _, err := os.Lstat(filepath.Join(f.path, "launch-Farol.app")); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("bad target published", err)
				}
			}
		})
	}
}

// Original native runtime/physical disposable route fixture, with a symbolic
// boot-composed measurement port. This does not qualify a process observation.
func TestRelaunchSelfMeasurementUsesCapturedPortAndOriginalBound(t *testing.T) {
	for _, fault := range []string{"none", "missing", "wrong-pid", "empty-start", "failed"} {
		t.Run(fault, func(t *testing.T) {
			f := newLifecycleFixture(t)
			cause := errors.New("measurement failed")
			calls := 0
			f.config.MeasureSelf = func(_ context.Context, until time.Time) (port.HelperSelfIdentity, error) {
				calls++
				if until.After(f.config.Until) {
					t.Fatal("measurement renewed the original bound")
				}
				self := port.HelperSelfIdentity{PID: int64(os.Getpid()), ProcessStart: "declared fixture birth"}
				switch fault {
				case "wrong-pid":
					self.PID++
				case "empty-start":
					self.ProcessStart = ""
				case "failed":
					return self, cause
				}
				return self, nil
			}
			if fault == "missing" {
				f.config.MeasureSelf = nil
			}
			var kept port.HelperRelaunchEffects
			err := withInstallation(context.Background(), f.config, func(context.Context) error { return nil }, func(native port.HelperInstallationRuntime) error {
				kept = native.(port.HelperRelaunchEffects)
				self, err := kept.SelfIdentity(context.Background())
				if fault == "none" {
					if err != nil || self.PID != int64(os.Getpid()) || self.ProcessStart != "declared fixture birth" {
						t.Fatal("boot measurement lost", self, err)
					}
					return nil
				}
				if err == nil || self != (port.HelperSelfIdentity{}) {
					t.Fatal("unqualified self accepted", self, err)
				}
				if fault == "failed" && !errors.Is(err, cause) {
					t.Fatal("measurement cause lost")
				}
				return err
			})
			if (fault == "none") != (err == nil) {
				t.Fatal("measurement uncertainty changed", err)
			}
			want := 1
			if fault == "missing" {
				want = 0
			}
			if calls != want {
				t.Fatal("measurement omitted or repeated", calls)
			}
			if _, err := kept.SelfIdentity(context.Background()); err == nil || calls != want {
				t.Fatal("escaped runtime reentered measurement")
			}
		})
	}
}

//go:build darwin

package execution

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

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

func TestLaunchArgumentsMustNameTheVerifiedImage(t *testing.T) {
	request := port.HelperRequest{Home: "/Users/owner"}
	hint := "--farol-installed-update-relaunch={}"
	capture := "/Users/owner/Library/Application Support/io.github.legrch.farol/installed-updates/op/launch-Farol.app"
	for _, tc := range []struct {
		name   string
		shared bool
		app    string
		want   bool
	}{
		{"slot install opens the owner slot", false, "/Users/owner/Applications/Farol.app", true},
		{"slot install refuses another app", false, "/Applications/Other.app", false},
		{"shared install opens the verified permanent slot", true, "/Applications/Farol.app", true},
		{"shared install refuses the private capture as a second app", true, capture, false},
		{"shared install refuses the owner slot", true, "/Users/owner/Applications/Farol.app", false},
		{"shared install refuses an empty path", true, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := []string{"/usr/bin/open", "-a", tc.app, "--args", hint}
			if got := launchBound(request, tc.shared, args); got != tc.want {
				t.Fatalf("launchBound = %v, want %v", got, tc.want)
			}
		})
	}
	if launchBound(request, false, []string{"/usr/bin/open", "-a"}) {
		t.Fatal("short argument list accepted")
	}
	if launchBound(port.HelperRequest{}, false, []string{"/usr/bin/open", "-a", "/Applications/Farol.app", "--args", hint}) {
		t.Fatal("request without a home accepted")
	}
}

func TestSidecarArgumentsStayBoundToRequestAndImage(t *testing.T) {
	mode := "sidecar-only"
	r := port.HelperRequest{Home: "/Users/owner", RelaunchPresentation: &mode}
	base := []string{"/usr/bin/open", "-a", r.Home + "/Applications/Farol.app", "--args", "--farol-installed-update-relaunch={}"}
	args := append(append([]string(nil), base...), "--preview-window-mode=secondary-visible", "--sidecar-display-only")
	if !launchBound(r, false, args) || launchBound(r, false, base) {
		t.Fatal("requested presentation lost")
	}
	r.RelaunchPresentation = nil
	if launchBound(r, false, args) {
		t.Fatal("unsolicited presentation admitted")
	}
	r.RelaunchPresentation = &mode
	args[2] = "/Applications/Other.app"
	if launchBound(r, false, args) {
		t.Fatal("presentation redirected verified image")
	}
}

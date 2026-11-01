package process

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// deadlineWithoutNotification models an earlier deadline before cancellation is delivered.
type deadlineWithoutNotification struct{ deadline time.Time }

func (c deadlineWithoutNotification) Deadline() (time.Time, bool) { return c.deadline, true }
func (deadlineWithoutNotification) Done() <-chan struct{}         { return nil }
func (deadlineWithoutNotification) Err() error                    { return nil }
func (deadlineWithoutNotification) Value(any) any                 { return nil }

// No native command is entered. Process/open qualification belongs to Root.
func TestRelaunchDeterministicBoundsAndDrain(t *testing.T) {
	called := false
	fence := func(context.Context) error { called = true; return nil }
	args := []string{"/usr/bin/open", "-a", "/never-opened.app", "--args", "--farol-installed-update-relaunch={}"}
	if err := Open(context.Background(), time.Now().Add(-time.Second), args, fence); err == nil || called {
		t.Fatal("expired action reached native fence", err)
	}
	for _, size := range []int{0, 4096, 4097} {
		d := &drain{}
		if _, err := d.ReadFrom(strings.NewReader(strings.Repeat("x", size))); err != nil {
			t.Fatal(err)
		}
		if d.complete() != (size <= 4096) {
			t.Fatal("EOF/overflow classification changed", size)
		}
	}

	t.Run("caller_deadline_before_notification", func(t *testing.T) {
		entered := false
		stopBeforeNative := errors.New("fence stops before native dispatch")
		fence := func(context.Context) error { entered = true; return stopBeforeNative }
		ctx := deadlineWithoutNotification{deadline: time.Now().Add(-time.Second)}
		err := Open(ctx, time.Now().Add(time.Minute), args, fence)
		if entered || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expired caller deadline was not refused before fence: entered=%t sentinel=%t err=%v", entered, errors.Is(err, stopBeforeNative), err)
		}
	})
}

func TestClosedSidecarArgumentsReachTheOriginalFence(t *testing.T) {
	base := []string{"/usr/bin/open", "-a", "/never-opened.app", "--args", "--farol-installed-update-relaunch={}"}
	sidecar := append(append([]string(nil), base...), "--preview-window-mode=secondary-visible", "--sidecar-display-only")
	stop := errors.New("stop before native launch")
	for _, args := range [][]string{base, sidecar} {
		called := false
		err := Open(context.Background(), time.Now().Add(time.Minute), args, func(context.Context) error { called = true; return stop })
		if !called || !errors.Is(err, stop) {
			t.Fatal("valid closed arguments never reached the fence", args, err)
		}
	}
	for _, suffix := range [][]string{{"--sidecar-display-only"}, {"--sidecar-display-only", "--preview-window-mode=secondary-visible"}, {"--preview-window-mode=secondary-visible", "--allow-primary-display"}, {"--preview-window-mode=secondary-visible", "--sidecar-display-only", "extra"}} {
		args := append(append([]string(nil), base...), suffix...)
		called := false
		if err := Open(context.Background(), time.Now().Add(time.Minute), args, func(context.Context) error { called = true; return stop }); err == nil || called {
			t.Fatal("open suffix escaped its closed grammar", args, err)
		}
	}
}

// One real fixed Open child against an absent bundle in a fresh private namespace.
// Its terminal error and joined EOF do not prove successful application relaunch.
func TestOpenNativeMissingBundle(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled disposable Open failure")
	}
	root, err := os.MkdirTemp("", "farol-open-native-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED Open fixture:", root)
	bundle := filepath.Join(root, "absent-Farol.app")
	if _, err := os.Lstat(bundle); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("fixture bundle is not absent", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	until, _ := ctx.Deadline()
	fences := 0
	err = Open(ctx, until, []string{"/usr/bin/open", "-a", bundle, "--args", "--farol-installed-update-relaunch={}"}, func(context.Context) error { fences++; return nil })
	var failure *port.HelperRecoveryFailure
	if !errors.As(err, &failure) || failure.Code != "launch_failed" || failure.Phase != "refused" || failure.Internal || failure.Uncertain || failure.Cause == nil {
		t.Fatal("original Open child did not return a clean terminal failure", err)
	}
	if fences != 2 {
		t.Fatal("original pre/post fences not joined", fences)
	}
	if _, err := os.Lstat(bundle); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("refused fixture created an app", err)
	}
}

// The child has already actually exited and its diagnostics are joined when
// this fixture changes the original bound at the second fence. No app exists.
func TestOpenNativeFinalFenceBounds(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled final Open fence")
	}
	for _, kind := range []string{"cancel", "deadline"} {
		t.Run(kind, func(t *testing.T) {
			root, err := os.MkdirTemp("", "farol-open-final-fence-")
			if err != nil {
				t.Fatal(err)
			}
			t.Log("RETAINED Open final-fence fixture:", root)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			until := time.Now().Add(5 * time.Second)
			fences := 0
			err = Open(ctx, until, []string{"/usr/bin/open", "-a", filepath.Join(root, "absent-Farol.app"), "--args", "--farol-installed-update-relaunch={}"}, func(context.Context) error {
				fences++
				if fences == 2 {
					if kind == "cancel" {
						cancel()
					} else {
						time.Sleep(time.Until(until) + time.Millisecond)
					}
				}
				return nil
			})
			want := context.Canceled
			if kind == "deadline" {
				want = context.DeadlineExceeded
			}
			var failure *port.HelperRecoveryFailure
			if fences != 2 || !errors.As(err, &failure) || !failure.Uncertain || !errors.Is(err, want) {
				t.Fatalf("final fence published a stale terminal result: fences=%d err=%v", fences, err)
			}
		})
	}
}

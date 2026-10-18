//go:build darwin || linux

package installmove

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/infra/native/installcopy"
)

// Constructor-only deterministic policy. No File method/syscall is invoked.
func TestCapturePublicationDeterministicNamesAndRoles(t *testing.T) {
	d := Directory{File: &os.File{}, Identity: Identity{"1", "2"}}
	name := ".launch-capture-" + strings.Repeat("a", 24)
	fence := func(context.Context) error { return nil }
	until := time.Now().Add(time.Second)
	for _, bad := range []string{"Farol.app", "launch-Farol.app", ".launch-capture-", name + "a", "../" + name, ".launch-capture-" + strings.Repeat("A", 24), ".launch-capture-" + strings.Repeat("/", 24)} {
		if _, err := PrepareCapturePublication(d, bad, Identity{"1", "3"}, until, fence); err == nil {
			t.Fatal("accepted capture name", bad)
		}
	}
	if _, err := PrepareRename(Location{d, name}, Location{d, "launch-Farol.app"}, Identity{"1", "3"}, until, fence); err == nil {
		t.Fatal("ordinary move names weakened")
	}
	if _, err := PrepareExchange(Location{d, name}, Location{d, "launch-Farol.app"}, Identity{"1", "3"}, Identity{"1", "4"}, until, fence); err == nil {
		t.Fatal("exchange names weakened")
	}
	shared := d
	shared.Kind = SharedApplicationsParent
	if _, err := PrepareCapturePublication(shared, name, Identity{"1", "3"}, until, fence); err == nil {
		t.Fatal("shared Applications capture accepted")
	}
	publication, err := PrepareCapturePublication(d, name, Identity{"1", "3"}, until, fence)
	if err != nil || publication.left.Parent.File != publication.right.Parent.File || publication.left.Parent.Identity != publication.right.Parent.Identity || publication.exchange || publication.right.Name != "launch-Farol.app" {
		t.Fatal(publication, err)
	}
}

// Root-only physical private namespace tests with a symbolic admission fence.
// These prove no application tree/signature, real predecessor or writer grant.
func captureNativeFixture(t *testing.T) (string, Directory, installcopy.Directory) {
	t.Helper()
	if runtime.GOOS != "darwin" || os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled disposable Darwin capture custody")
	}
	root, err := os.MkdirTemp("", "farol-capture-native-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED capture fixture:", root)
	file, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := file.Close(); err != nil {
			t.Error("fixture parent cleanup", err)
		}
	})
	id := fileIdentity(t, file)
	return root, Directory{File: file, Identity: id}, installcopy.Directory{File: file, Identity: installcopy.Identity{Device: id.Device, Inode: id.Inode}}
}
func captureNativeIdentity(t *testing.T, path string) Identity {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	return fileIdentity(t, file)
}
func TestCaptureNativePublicationCustody(t *testing.T) {
	for _, kind := range []string{"published", "collision", "substituted", "callback-failure"} {
		t.Run(kind, func(t *testing.T) {
			root, parent, copyParent := captureNativeFixture(t)
			target := filepath.Join(root, "launch-Farol.app")
			var existing Identity
			if kind == "collision" {
				mustCapture(t, os.Mkdir(target, 0700))
				existing = captureNativeIdentity(t, target)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			until, _ := ctx.Deadline()
			var name string
			var original Identity
			private := errors.New("private capture callback failure")
			err := installcopy.WithCapture(ctx, copyParent, until, func(context.Context) error { return nil }, func(capture string, child installcopy.Directory) error {
				name = capture
				original = Identity{Device: child.Identity.Device, Inode: child.Identity.Inode}
				if kind == "callback-failure" {
					return private
				}
				if kind == "substituted" {
					mustCapture(t, os.Rename(filepath.Join(root, capture), filepath.Join(root, "preserved-original-capture")))
					mustCapture(t, os.Mkdir(filepath.Join(root, capture), 0700))
				}
				publication, e := PrepareCapturePublication(parent, capture, original, until, func(context.Context) error { return nil })
				if e != nil {
					return e
				}
				return publication.Run(ctx)
			})
			if name == "" {
				t.Fatal("capture callback was not reached", err)
			}
			if kind == "published" {
				if err != nil {
					t.Fatal(err)
				}
				if got := captureNativeIdentity(t, target); got != original {
					t.Fatal("publication adopted another inode", got, original)
				}
				if _, e := os.Lstat(filepath.Join(root, name)); !errors.Is(e, os.ErrNotExist) {
					t.Fatal("capture remained after successful publication", e)
				}
			} else {
				var failure *installcopy.Failure
				if !errors.As(err, &failure) || !failure.Uncertain {
					t.Fatal("post-create failure lost uncertainty", err)
				}
				if kind == "callback-failure" && !errors.Is(err, private) {
					t.Fatal("original callback cause lost", err)
				}
				if kind == "collision" {
					if got := captureNativeIdentity(t, target); got != existing {
						t.Fatal("existing target displaced", got, existing)
					}
					if got := captureNativeIdentity(t, filepath.Join(root, name)); got != original {
						t.Fatal("failed capture lost", got, original)
					}
				} else {
					if _, e := os.Lstat(target); !errors.Is(e, os.ErrNotExist) {
						t.Fatal("refused capture was published", e)
					}
					if kind == "substituted" {
						if got := captureNativeIdentity(t, filepath.Join(root, "preserved-original-capture")); got != original {
							t.Fatal("original capture lost", got, original)
						}
						if got := captureNativeIdentity(t, filepath.Join(root, name)); got == original {
							t.Fatal("substitution was not exercised")
						}
					} else if got := captureNativeIdentity(t, filepath.Join(root, name)); got != original {
						t.Fatal("failed capture removed", got, original)
					}
				}
			}
			if _, e := parent.File.Stat(); e != nil {
				t.Fatal("borrowed original parent closed", e)
			}
		})
	}
}
func mustCapture(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// This holds the entered callback beyond expiry and checks pending custody
// BEFORE releasing it. It is no physical OS Close-failure injection.
func TestCaptureNativeJoinsExpiredCallback(t *testing.T) {
	_, parent, copyParent := captureNativeFixture(t)
	until := time.Now().Add(time.Second)
	ctx, cancel := context.WithDeadline(context.Background(), until)
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	done := make(chan error, 1)
	go func() {
		done <- installcopy.WithCapture(ctx, copyParent, until, func(context.Context) error { return nil }, func(string, installcopy.Directory) error { close(entered); <-release; return nil })
	}()
	select {
	case <-entered:
	case err := <-done:
		t.Fatal("callback not entered", err)
	}
	time.Sleep(time.Until(until) + time.Millisecond)
	var early *error
	select {
	case err := <-done:
		early = &err
		t.Error("expired call detached entered callback/cleanup")
	default:
	}
	if _, err := parent.File.Stat(); err != nil {
		t.Error("borrowed parent closed during callback", err)
	}
	close(release)
	released = true
	var err error
	if early != nil {
		err = *early
	} else {
		err = <-done
	}
	var failure *installcopy.Failure
	if !errors.As(err, &failure) || !failure.Uncertain || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("late capture success or lost cause", err)
	}
	if _, e := parent.File.Stat(); e != nil {
		t.Fatal("borrowed original parent closed", e)
	}
}

// An independent finite until must reach both context-aware fences. The
// original source fails promptly at the final fence instead of hanging there.
func TestCaptureNativeFenceKeepsIndependentUntil(t *testing.T) {
	for _, kind := range []string{"operation", "caller"} {
		t.Run(kind, func(t *testing.T) {
			_, parent, copyParent := captureNativeFixture(t)
			ctx := context.Background()
			until := time.Now().Add(250 * time.Millisecond)
			want := until
			if kind == "caller" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, want)
				defer cancel()
				until = want.Add(time.Minute)
			}
			calls, captured := 0, false
			missing := errors.New("final capture fence lacks original deadline")
			err := installcopy.WithCapture(ctx, copyParent, until, func(c context.Context) error {
				calls++
				if calls != 2 {
					return nil
				}
				deadline, ok := c.Deadline()
				if !ok || !deadline.Equal(want) {
					return missing
				}
				<-c.Done()
				return c.Err()
			}, func(string, installcopy.Directory) error { captured = true; return nil })
			var failure *installcopy.Failure
			if calls != 2 || !captured || !errors.As(err, &failure) || !failure.Uncertain || !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("original capture bound did not reach final fence: calls=%d captured=%t missing=%t err=%v", calls, captured, errors.Is(err, missing), err)
			}
			if _, err := parent.File.Stat(); err != nil {
				t.Fatal("original borrowed parent closed", err)
			}
		})
	}
}

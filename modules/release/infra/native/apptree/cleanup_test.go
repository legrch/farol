package apptree

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Close is still performed exactly once on the real disposable descriptor;
// the injected failure models a lost/error cleanup result, never a leaked fd.
func TestEveryOwnedTreeClosePreservesFailure(t *testing.T) {
	for _, kind := range []string{"file", "directory", "enumeration", "document", "root"} {
		t.Run(kind, func(t *testing.T) {
			app, p, a := fixture(t)
			private := errors.New("private cleanup diagnostic")
			v := verifier(t, p, a, appGolden, accept)
			var injected atomic.Bool
			v.cleanup.closeFile = func(f *os.File) error {
				err := f.Close()
				if kind == "enumeration" && !injected.Swap(true) {
					return errors.Join(err, private)
				}
				return err
			}
			v.cleanup.closeFD = func(fd int) error {
				var s unix.Stat_t
				must(t, unix.Fstat(fd, &s))
				var target string
				// Resolve only test-owned descriptors for selecting a deterministic stage.
				if s.Mode&unix.S_IFMT == unix.S_IFREG {
					target = "file"
				} else {
					target = "directory"
				}
				err := unix.Close(fd)
				chosen := kind == target
				if kind == "root" {
					var root unix.Stat_t
					must(t, unix.Lstat(app, &root))
					chosen = s.Ino == root.Ino
				}
				if chosen && !injected.Swap(true) {
					return errors.Join(err, private)
				}
				return err
			}
			if kind == "document" {
				// First document read closes an Info.plist descriptor. Other regular
				// files are visited first during the digest walk, so count its returns.
				count := 0
				v.cleanup.closeFD = func(fd int) error {
					var s unix.Stat_t
					must(t, unix.Fstat(fd, &s))
					err := unix.Close(fd)
					if s.Mode&unix.S_IFMT == unix.S_IFREG {
						count++
						if count == 3 {
							injected.Store(true)
							return errors.Join(err, private)
						}
					}
					return err
				}
			}
			observation, err := v.Verify(context.Background())
			if !injected.Load() || err == nil || observation != (Observation{}) || !errors.Is(err, private) {
				t.Fatalf("cleanup failure lost: injected=%v observation=%#v err=%v", injected.Load(), observation, err)
			}
			if strings.Contains(err.Error(), "private") || IsVerificationRefusal(err, func(error) bool { return true }) {
				t.Fatal("cleanup disclosed or downgraded to negative match")
			}
			_, err = p.Stat()
			must(t, err)
			_, err = a.Stat()
			must(t, err)
		})
	}
}

func TestCleanupJoinsActualReturnCancellationAndOriginalRefusal(t *testing.T) {
	app, p, a := fixture(t)
	v := verifier(t, p, a, strings.Repeat("f", 64), accept)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	private := errors.New("cleanup failed")
	entered, drain := make(chan struct{}), make(chan struct{})
	var root unix.Stat_t
	must(t, unix.Lstat(app, &root))
	v.cleanup.closeFD = func(fd int) error {
		var s unix.Stat_t
		must(t, unix.Fstat(fd, &s))
		err := unix.Close(fd)
		if s.Ino == root.Ino {
			close(entered)
			<-drain
			return errors.Join(err, private)
		}
		return err
	}
	done := make(chan error, 1)
	go func() { _, err := v.Verify(ctx); done <- err }()
	<-entered
	cancel()
	select {
	case <-done:
		t.Fatal("returned before actual close result")
	case <-time.After(time.Millisecond):
	}
	close(drain)
	err := <-done
	if !errors.Is(err, private) || !errors.Is(err, context.Canceled) || IsVerificationRefusal(err, nil) {
		t.Fatal("cleanup/cancellation provenance lost", err)
	}
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != CodeIO {
		t.Fatal("cleanup not internal IO")
	}
}

package helperroutes

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestReadAndOpenFaultCausesAndCancellation(t *testing.T) {
	for _, syscall := range []string{"root-stat", "root-open", "statat", "fstat", "openat"} {
		for _, canceled := range []bool{false, true} {
			t.Run(syscall+map[bool]string{false: "", true: "/cancel"}[canceled], func(t *testing.T) {
				f := newFixture(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				fail := func() error {
					if canceled {
						cancel()
					}
					return unix.EIO
				}
				switch syscall {
				case "root-stat":
					f.fs.rootStat = func(*unix.Stat_t) error { return fail() }
				case "root-open":
					f.fs.rootOpen = func() (int, error) { return -1, fail() }
				case "statat":
					f.fs.statat = func(int, string, *unix.Stat_t, int) error { return fail() }
				case "fstat":
					f.fs.fstat = func(int, *unix.Stat_t) error { return fail() }
				case "openat":
					f.fs.openat = func(int, string, int, uint32) (int, error) { return -1, fail() }
				}
				_, err := openExisting(ctx, "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
				classified(t, err, CodeNative, true)
				if !errors.Is(err, unix.EIO) || canceled && !errors.Is(err, context.Canceled) {
					t.Fatal("lost native/cancel cause")
				}
			})
		}
	}
}

func TestBeforeAfterOpenFullIdentityChecks(t *testing.T) {
	for _, change := range []string{"mode", "replace", "replace-after-open"} {
		t.Run(change, func(t *testing.T) {
			f := newFixture(t)
			original := f.fs.openat
			f.fs.openat = func(parent int, name string, flags int, mode uint32) (int, error) {
				if name != operationID {
					return original(parent, name, flags, mode)
				}
				if change == "mode" {
					must(t, os.Chmod(f.operation, 0750))
				}
				if change == "replace" {
					must(t, os.Rename(f.operation, f.operation+"-old"))
					must(t, os.Mkdir(f.operation, 0700))
				}
				fd, err := original(parent, name, flags, mode)
				if change == "replace-after-open" {
					must(t, os.Rename(f.operation, f.operation+"-old"))
					must(t, os.Mkdir(f.operation, 0700))
				}
				return fd, err
			}
			_, err := openExisting(context.Background(), "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
			classified(t, err, CodeChanged, false)
		})
	}
}

func TestOpenInspectedAndUnexpectedFailuresStayDistinct(t *testing.T) {
	for _, tc := range []struct {
		cause    error
		code     Code
		internal bool
	}{
		{unix.ENOENT, CodeChanged, true}, {unix.ENOTDIR, CodeChanged, true}, {unix.ELOOP, CodeChanged, true},
		{unix.EACCES, CodeNative, true}, {unix.EMFILE, CodeNative, true},
	} {
		f := newFixture(t)
		f.fs.openat = func(int, string, int, uint32) (int, error) { return -1, tc.cause }
		_, err := openExisting(context.Background(), "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
		classified(t, err, tc.code, tc.internal)
		if !errors.Is(err, tc.cause) {
			t.Fatal("lost syscall cause")
		}
	}
}

func TestCleanupCollectsEveryFailureAndClosesOnce(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	first, second := errors.New("close-private-first"), errors.New("close-private-second")
	counts := map[*os.File]int{}
	r.owner.fs.close = func(file *os.File) error {
		counts[file]++
		must(t, file.Close())
		if file == r.owner.nodes[0].file {
			return first
		}
		if file == r.owner.nodes[len(r.owner.nodes)-1].file {
			return second
		}
		return nil
	}
	err := r.Close()
	classified(t, err, CodeCleanup, true)
	if !errors.Is(err, first) || !errors.Is(err, second) {
		t.Fatal("cleanup lost cause")
	}
	copy := *r
	if copy.Close() != err {
		t.Fatal("close outcome changed")
	}
	for _, n := range r.owner.nodes {
		if counts[n.file] != 1 {
			t.Fatal("duplicate or skipped close")
		}
	}
	// The fixture cleanup expects a successful close; its test-only close result
	// can be cleared only after the persistent-error assertions above.
	r.owner.closeErr = nil
}

func TestOpenRefusalRetainsCleanupFailure(t *testing.T) {
	f := newFixture(t)
	closed := 0
	cleanupCause := errors.New("private cleanup cause")
	f.fs.close = func(file *os.File) error { closed++; must(t, file.Close()); return cleanupCause }
	must(t, os.Remove(f.operation))
	_, err := openExisting(context.Background(), "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
	classified(t, err, CodeMissing, true)
	if !errors.Is(err, unix.ENOENT) || !errors.Is(err, cleanupCause) || closed < 2 {
		t.Fatal("cleanup/lower cause lost")
	}
}

func TestPostCallbackCleanupFailurePreservesCallback(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	cause, cleanupCause := errors.New("callback private"), errors.New("cleanup private")
	original := r.owner.fs.close
	ownedFiles := map[*os.File]bool{}
	for _, n := range r.owner.nodes {
		ownedFiles[n.file] = true
	}
	r.owner.fs.close = func(file *os.File) error {
		err := original(file)
		if !ownedFiles[file] {
			return errors.Join(err, cleanupCause)
		}
		return err
	}
	// Preverification also closes fresh descriptors, so enable the failing close
	// only from inside the callback to target the postcallback observation.
	failing := r.owner.fs.close
	r.owner.fs.close = original
	err := r.WithFiles(context.Background(), func(Files) error { r.owner.fs.close = failing; return cause })
	classified(t, err, CodeCallback, true)
	if !errors.Is(err, cause) || !errors.Is(err, cleanupCause) {
		t.Fatal("postverification cause lost")
	}
}

func TestCancellationBeforeAndDuringNativeReturnNeverLeaksFiles(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := false
	f.fs.rootOpen = func() (int, error) { called = true; return -1, unix.EIO }
	_, err := openExisting(ctx, "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
	classified(t, err, CodeContext, false)
	if called {
		t.Fatal("native work began after cancellation")
	}

	f = newFixture(t)
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	original := f.fs.openat
	opened, closed := 0, 0
	f.fs.openat = func(parent int, name string, flags int, mode uint32) (int, error) {
		fd, err := original(parent, name, flags, mode)
		if err == nil {
			opened++
		}
		cancel()
		return fd, err
	}
	f.fs.close = func(file *os.File) error { closed++; return file.Close() }
	_, err = openExisting(ctx, "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
	classified(t, err, CodeContext, false)
	if opened != 1 || closed != 2 {
		t.Fatalf("opened=%d closed=%d", opened, closed)
	}
}

func TestBlockedNativeReturnRetainsOwnerThroughCancelAndClose(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	original := r.owner.fs.fstat
	r.owner.fs.fstat = func(fd int, s *unix.Stat_t) error {
		if fd == r.owner.nodes[r.owner.operation].fd {
			once.Do(func() { close(entered); <-release })
		}
		return original(fd, s)
	}
	result := make(chan error, 1)
	go func() { result <- r.Verify(ctx) }()
	<-entered
	cancel()
	closed := make(chan error, 1)
	go func() { closed <- r.Close() }()
	select {
	case err := <-result:
		t.Fatalf("abandoned native call: %v", err)
	default:
	}
	select {
	case err := <-closed:
		t.Fatalf("closed blocked native call: %v", err)
	default:
	}
	for _, n := range r.owner.nodes {
		if _, err := n.file.Stat(); err != nil {
			t.Fatal("native file closed")
		}
	}
	close(release)
	classified(t, <-result, CodeContext, false)
	must(t, <-closed)
}

func TestCancellationDuringFreshCleanupCannotReturnSuccess(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	original := f.fs.close
	f.fs.close = func(file *os.File) error { cancel(); return original(file) }
	r, err := openExisting(ctx, "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
	classified(t, err, CodeContext, false)
	if r != nil {
		t.Fatal("owner escaped cancelled cleanup")
	}
}

func TestBoundedMessagesAndExactTypedCallbackCause(t *testing.T) {
	if got := (&Error{Code: Code("private/path/os message")}).Error(); got != "helper routes: native" {
		t.Fatalf("unbounded code: %q", got)
	}
	f := newFixture(t)
	r := f.open(t)
	typed := &os.PathError{Op: "private", Path: "private/path", Err: unix.EIO}
	err := r.WithFiles(context.Background(), func(Files) error { return typed })
	classified(t, err, CodeCallback, true)
	var pathErr *os.PathError
	if !errors.As(err, &pathErr) || pathErr != typed || !errors.Is(err, unix.EIO) {
		t.Fatal("exact typed callback cause lost")
	}
}

func TestUnavailableDependencyDoesNotEraseCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := newFixture(t)
	r := f.open(t)
	var nilRoutes *Routes
	for _, err := range []error{nilRoutes.Verify(ctx), r.WithFiles(ctx, nil)} {
		classified(t, err, CodeDependency, true)
		if !errors.Is(err, context.Canceled) {
			t.Fatal("dependency erased cancellation")
		}
	}
}

func TestTypedNilAndMalformedCallbackErrorsAreInternal(t *testing.T) {
	var typedNil *Error
	for _, tc := range []struct {
		name  string
		cause error
	}{
		{"typed_nil", typedNil}, {"malformed", &Error{Code: Code("private/path native message"), Internal: false}}, {"zero", &Error{}},
	} {
		for _, canceled := range []bool{false, true} {
			t.Run(tc.name+"/"+map[bool]string{false: "active", true: "cancelled"}[canceled], func(t *testing.T) {
				defer func() {
					if recover() != nil {
						t.Error("callback error classification panicked")
					}
				}()
				f := newFixture(t)
				r := f.open(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				err := r.WithFiles(ctx, func(Files) error {
					if canceled {
						cancel()
					}
					return tc.cause
				})
				classified(t, err, CodeCallback, true)
				if !errors.Is(err, tc.cause) || canceled && !errors.Is(err, context.Canceled) {
					t.Fatal("callback/cancel cause lost")
				}
			})
		}
	}
}

func TestCombineTypedNilAndMalformedErrorsKeepsClosedInternalCode(t *testing.T) {
	var typedNil *Error
	for _, tc := range []struct {
		name  string
		cause error
	}{
		{"typed_nil", typedNil}, {"malformed", &Error{Code: Code("private/path native message"), Internal: false}}, {"zero", &Error{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() != nil {
					t.Error("combined error classification panicked")
				}
			}()
			for _, secondary := range []error{nil, failure(CodeContext, false, context.Canceled)} {
				err := combine(tc.cause, secondary)
				classified(t, err, CodeNative, true)
				if !errors.Is(err, tc.cause) || secondary != nil && !errors.Is(err, context.Canceled) {
					t.Fatal("combined cause lost")
				}
			}
		})
	}
}

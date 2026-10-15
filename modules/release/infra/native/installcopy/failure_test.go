//go:build linux || darwin

package installcopy

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestNativeErrnosRemainInternal(t *testing.T) {
	for _, tc := range []struct {
		errno error
		code  string
	}{
		{unix.EACCES, "mode"}, {unix.EPERM, "mode"}, {unix.ENOENT, "changed"},
		{unix.ELOOP, "changed"}, {unix.EEXIST, "collision"}, {unix.EIO, "io"}, {unix.EINTR, "io"},
	} {
		t.Run(tc.errno.Error(), func(t *testing.T) {
			f := setup(t)
			op := f.prepare(t, nil)
			r := runner{ctx: context.Background(), c: op.capture}
			original := &os.PathError{Op: "private", Path: "/never/leak/native/path", Err: tc.errno}
			err := r.call("test-native-error", func() error { return original })
			x := failure(t, err, tc.code, false, true)
			if !errors.Is(x, original) || !errors.Is(x, tc.errno) || strings.Contains(x.Error(), "never") {
				t.Fatal("native cause/classification lost or path leaked")
			}
		})
	}
}

func TestFirstCreatesCanFailAfterMutation(t *testing.T) {
	for _, kind := range []string{"file", "directory", "symlink"} {
		for _, errno := range []error{unix.EIO, unix.EINTR} {
			t.Run(kind+"/"+errno.Error(), func(t *testing.T) {
				f := setup(t)
				p := filepath.Join(f.source, "a")
				switch kind {
				case "file":
					put(t, p, "data", 0600)
				case "directory":
					if err := os.Mkdir(p, 0700); err != nil {
						t.Fatal(err)
					}
				case "symlink":
					if err := os.Symlink("relative", p); err != nil {
						t.Fatal(err)
					}
				}
				op := f.prepare(t, nil)
				h := hooks{
					open: func(parent int, name string, flags int, mode uint32) (int, error) {
						fd, err := unix.Openat(parent, name, flags, mode)
						if err == nil && flags&unix.O_CREAT != 0 {
							if e := unix.Close(fd); e != nil {
								t.Error(e)
							}
							return -1, errno
						}
						return fd, err
					},
					mkdir: func(parent int, name string, mode uint32) error {
						if err := unix.Mkdirat(parent, name, mode); err != nil {
							return err
						}
						return errno
					},
					symlink: func(text string, parent int, name string) error {
						if err := unix.Symlinkat(text, parent, name); err != nil {
							return err
						}
						return errno
					},
				}
				err := op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h)
				failure(t, err, "io", true, true)
				if !errors.Is(err, errno) {
					t.Fatal("original create errno lost")
				}
				if _, err := os.Lstat(filepath.Join(f.destination, "a")); err != nil {
					t.Fatal("partial mutation was not exercised")
				}
				failure(t, op.Run(context.Background()), "consumed", true, false)
			})
		}
	}
}

func TestUnexpectedIODoesNotDisappearUnderCancellation(t *testing.T) {
	for _, where := range []string{"create", "write", "sync", "close"} {
		t.Run(where, func(t *testing.T) {
			f := setup(t)
			put(t, filepath.Join(f.source, "a"), "data", 0600)
			op := f.prepare(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			h := hooks{}
			switch where {
			case "create":
				h.open = func(parent int, name string, flags int, mode uint32) (int, error) {
					fd, err := unix.Openat(parent, name, flags, mode)
					if err == nil && flags&unix.O_CREAT != 0 {
						if e := unix.Close(fd); e != nil {
							t.Error(e)
						}
						cancel()
						return -1, unix.EIO
					}
					return fd, err
				}
			case "write":
				h.write = func(fd int, p []byte) (int, error) { n, _ := unix.Write(fd, p); cancel(); return n, unix.EIO }
			case "sync":
				h.fsync = func(int) error { cancel(); return unix.EIO }
			case "close":
				h.close = func(fd int) error {
					if err := unix.Close(fd); err != nil {
						t.Error(err)
					}
					cancel()
					return unix.EIO
				}
			}
			err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, h)
			failure(t, err, "io", true, true)
			if !errors.Is(err, context.Canceled) || !errors.Is(err, unix.EIO) {
				t.Fatal("concurrent native/cancellation cause lost")
			}
		})
	}
}

func containsCode(err error, code string) bool {
	if err == nil {
		return false
	}
	if f, ok := err.(*Failure); ok && f != nil && f.Code == code {
		return true
	}
	if many, ok := err.(interface{ Unwrap() []error }); ok {
		for _, e := range many.Unwrap() {
			if containsCode(e, code) {
				return true
			}
		}
		return false
	}
	return containsCode(errors.Unwrap(err), code)
}

func TestCloseFailureRetainsOriginalRefusalAndCancellation(t *testing.T) {
	for _, alsoCancel := range []bool{false, true} {
		t.Run(fmt.Sprint(alsoCancel), func(t *testing.T) {
			f := setup(t)
			put(t, filepath.Join(f.source, "a"), "data", 0600)
			op := f.prepare(t, nil)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			h := hooks{write: func(int, []byte) (int, error) { return 0, nil }, close: func(fd int) error {
				if err := unix.Close(fd); err != nil {
					t.Error(err)
				}
				if alsoCancel {
					cancel()
				}
				return unix.EIO
			}}
			err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, h)
			failure(t, err, "io", true, true)
			if !containsCode(err, "launch_copy_write") || !errors.Is(err, unix.EIO) {
				t.Fatal("cleanup hid original classified refusal or native cause")
			}
			if alsoCancel && !errors.Is(err, context.Canceled) {
				t.Fatal("cleanup lost cancellation cause")
			}
		})
	}
}

func TestLaterCollisionKeepsEarlierUncertainty(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "first", 0600)
	put(t, filepath.Join(f.source, "b"), "second", 0600)
	op := f.prepare(t, nil)
	h := hooks{open: func(parent int, name string, flags int, mode uint32) (int, error) {
		if name == "b" && flags&unix.O_CREAT != 0 {
			put(t, filepath.Join(f.destination, "b"), "foreign", 0600)
		}
		return unix.Openat(parent, name, flags, mode)
	}}
	err := op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, h)
	failure(t, err, "collision", true, true)
	if !errors.Is(err, unix.EEXIST) {
		t.Fatal("collision errno lost")
	}
	for name, want := range map[string]string{"a": "first", "b": "foreign"} {
		got, err := os.ReadFile(filepath.Join(f.destination, name))
		if err != nil || string(got) != want {
			t.Fatal("collision changed retained entry")
		}
	}
}

func TestDeadlineDoesNotMaskUnexpectedSyncError(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "data", 0600)
	op := f.prepare(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, hooks{fsync: func(int) error { <-ctx.Done(); return unix.EIO }})
	failure(t, err, "io", true, true)
	if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, unix.EIO) {
		t.Fatal("deadline/native cause lost")
	}
}

func TestPostFenceInternalClassificationSurvivesCancellationCause(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "data", 0600)
	calls := 0
	original := &Failure{Code: "launch_copy_io", Internal: true, cause: context.Canceled}
	op := f.prepare(t, func(context.Context) error {
		calls++
		if calls == 2 {
			return original
		}
		return nil
	})
	err := op.Run(context.Background())
	failure(t, err, "io", true, true)
	if !errors.Is(err, original) || !errors.Is(err, context.Canceled) {
		t.Fatal("fence's internal classification or cancellation cause lost")
	}
}

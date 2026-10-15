//go:build darwin || linux

package installmove

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// These are disposable filesystem tests. Linux exercises the private injected
// backend and proves no Darwin behavior or installed-update acceptance.
type fixture struct {
	t           *testing.T
	root        string
	left, right Location
	le, re      Identity
}

func newFixture(t *testing.T, exchange bool, sameParent bool) *fixture {
	t.Helper()
	f := &fixture{t: t, root: t.TempDir()}
	open := func(name string) Directory {
		path := filepath.Join(f.root, name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = file.Close() })
		return Directory{File: file, Identity: fileIdentity(t, file)}
	}
	f.left = Location{Parent: open("left"), Name: "staged.app"}
	f.right = Location{Parent: f.left.Parent, Name: "previous.app"}
	if !sameParent {
		f.right.Parent = open("right")
	}
	f.le = f.makeEntry(f.left)
	if exchange {
		f.re = f.makeEntry(f.right)
	}
	return f
}
func fileIdentity(t *testing.T, file *os.File) Identity {
	t.Helper()
	raw, err := file.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var identity Identity
	if err := raw.Control(func(fd uintptr) {
		m, err := (unixBackend{}).held(int(fd))
		if err != nil {
			t.Fatal(err)
		}
		identity = m.identity
	}); err != nil {
		t.Fatal(err)
	}
	return identity
}
func (f *fixture) path(l Location) string { return filepath.Join(l.Parent.File.Name(), l.Name) }
func (f *fixture) makeEntry(l Location) Identity {
	f.t.Helper()
	if err := os.Mkdir(f.path(l), 0700); err != nil {
		f.t.Fatal(err)
	}
	file, err := os.Open(f.path(l))
	if err != nil {
		f.t.Fatal(err)
	}
	defer file.Close()
	return fileIdentity(f.t, file)
}
func (f *fixture) operation(exchange bool, b backend, fence Fence) *Operation {
	f.t.Helper()
	if fence == nil {
		fence = func(context.Context) error { return nil }
	}
	o, err := prepare(f.left, f.right, f.le, f.re, time.Now().Add(time.Minute), fence, exchange, b)
	if err != nil {
		f.t.Fatal(err)
	}
	return o
}
func testNative() backend { return unixBackend{effect: disposableMove} }
func wantFailure(t *testing.T, err error, code string, uncertain, internal bool) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != code || f.Uncertain != uncertain || f.Internal != internal {
		t.Fatalf("got %#v, want %s uncertain=%v internal=%v", err, code, uncertain, internal)
	}
}
func assertEntry(t *testing.T, l Location, expected Identity) {
	t.Helper()
	file, err := os.Open(filepath.Join(l.Parent.File.Name(), l.Name))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if got := fileIdentity(t, file); got != expected {
		t.Fatalf("identity got %v want %v", got, expected)
	}
}
func assertAbsent(t *testing.T, l Location) {
	t.Helper()
	_, err := os.Lstat(filepath.Join(l.Parent.File.Name(), l.Name))
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected absent: %v", err)
	}
}

func TestRenameAndExchange(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		for _, same := range []bool{false, true} {
			t.Run(map[bool]string{false: "rename", true: "exchange"}[exchange]+map[bool]string{false: "/two-parents", true: "/same-parent"}[same], func(t *testing.T) {
				f := newFixture(t, exchange, same)
				var syncs []int
				b := &faultBackend{backend: testNative(), syncFn: func(fd int) error { syncs = append(syncs, fd); return unix.Fsync(fd) }}
				o := f.operation(exchange, b, nil)
				if err := o.Run(context.Background()); err != nil {
					t.Fatal(err)
				}
				assertEntry(t, f.right, f.le)
				if exchange {
					assertEntry(t, f.left, f.re)
				} else {
					assertAbsent(t, f.left)
				}
				if len(syncs) != 2 {
					t.Fatalf("synced %d parents", len(syncs))
				}
				for _, parent := range []Directory{f.left.Parent, f.right.Parent} {
					if _, err := parent.File.Stat(); err != nil {
						t.Fatal("borrowed parent closed", err)
					}
				}
				wantFailure(t, o.Run(context.Background()), "operation_consumed", true, false)
			})
		}
	}
}

func TestInputValidationAndCapture(t *testing.T) {
	f := newFixture(t, true, false)
	for _, bad := range []string{"", "00", "+1", "-1", " 1", "1.0", "18446744073709551616", "000000000000000000000"} {
		for _, device := range []bool{false, true} {
			id := f.le
			if device {
				id.Device = bad
			} else {
				id.Inode = bad
			}
			_, err := prepare(f.left, f.right, id, f.re, time.Now().Add(time.Minute), func(context.Context) error { return nil }, true, testNative())
			wantFailure(t, err, "input", false, false)
		}
	}
	if !validIdentity(Identity{"0", "0"}) || !validIdentity(Identity{"18446744073709551615", "18446744073709551615"}) {
		t.Fatal("unsigned canonical boundary rejected")
	}
	for _, name := range []string{"", ".", "..", "a", "../Farol.app", "/Farol.app", "Farol.app/", "Farol.app\x00"} {
		left := f.left
		left.Name = name
		_, err := prepare(left, f.right, f.le, f.re, time.Now().Add(time.Minute), func(context.Context) error { return nil }, true, testNative())
		wantFailure(t, err, "input", false, false)
	}
	for _, change := range []func(*Location, *Location, *Identity, *time.Time, *Fence){
		func(l, r *Location, i *Identity, u *time.Time, f *Fence) { l.Parent.File = nil },
		func(l, r *Location, i *Identity, u *time.Time, f *Fence) { l.Parent.Identity.Inode = "00" },
		func(l, r *Location, i *Identity, u *time.Time, f *Fence) { *r = *l },
		func(l, r *Location, i *Identity, u *time.Time, f *Fence) { *u = time.Time{} },
		func(l, r *Location, i *Identity, u *time.Time, f *Fence) { *f = nil },
	} {
		l, r, id, until, fence := f.left, f.right, f.le, time.Now().Add(time.Minute), Fence(func(context.Context) error { return nil })
		change(&l, &r, &id, &until, &fence)
		_, err := prepare(l, r, id, f.re, until, fence, true, testNative())
		wantFailure(t, err, "input", false, false)
	}
	l, r, le, re := f.left, f.right, f.le, f.re
	o, err := prepare(l, r, le, re, time.Now().Add(time.Minute), func(context.Context) error { return nil }, true, testNative())
	if err != nil {
		t.Fatal(err)
	}
	l.Name = "failed.app"
	r.Parent.Identity = Identity{}
	le.Inode = "0"
	re.Device = "0"
	if err := o.Run(context.Background()); err != nil {
		t.Fatal("captured values changed", err)
	}
}

func TestUnsupportedHasNoIOOrMutation(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("production Darwin backend is supported")
	}
	f := newFixture(t, true, false)
	called := false
	fence := func(context.Context) error { called = true; return nil }
	_, err := PrepareRename(f.left, f.right, f.le, time.Now().Add(time.Minute), fence)
	wantFailure(t, err, "rename_unsupported", false, false)
	_, err = PrepareExchange(f.left, f.right, f.le, f.re, time.Now().Add(time.Minute), fence)
	wantFailure(t, err, "exchange_unsupported", false, false)
	if called {
		t.Fatal("unsupported called fence")
	}
	assertEntry(t, f.left, f.le)
	assertEntry(t, f.right, f.re)
}

func TestPreconditions(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		for _, scenario := range []string{"source-identity", "parent-identity", "parent-type", "parent-mode", "source-symlink", "source-file", "source-missing", "target-collision", "target-symlink", "target-identity", "cross-device"} {
			t.Run(map[bool]string{false: "rename/", true: "exchange/"}[exchange]+scenario, func(t *testing.T) {
				f := newFixture(t, exchange, false)
				b := testNative()
				code := "source_replaced"
				if exchange {
					code = "exchange_precondition"
				}
				switch scenario {
				case "source-identity":
					f.le.Inode = "0"
				case "parent-identity":
					f.left.Parent.Identity.Inode = "0"
					code = "parent_replaced"
				case "parent-type":
					file, err := os.Create(filepath.Join(f.root, "file"))
					if err != nil {
						t.Fatal(err)
					}
					defer file.Close()
					f.left.Parent = Directory{File: file, Identity: fileIdentity(t, file)}
					code = "parent_replaced"
				case "parent-mode":
					if err := os.Chmod(f.left.Parent.File.Name(), 0777); err != nil {
						t.Fatal(err)
					}
					code = "parent_replaced"
				case "source-symlink", "source-file", "source-missing":
					if err := os.Remove(f.path(f.left)); err != nil {
						t.Fatal(err)
					}
					if scenario == "source-symlink" {
						if err := os.Symlink(f.root, f.path(f.left)); err != nil {
							t.Fatal(err)
						}
					}
					if scenario == "source-file" {
						if err := os.WriteFile(f.path(f.left), nil, 0600); err != nil {
							t.Fatal(err)
						}
					}
				case "target-collision":
					if exchange {
						f.re.Inode = "0"
					} else {
						f.makeEntry(f.right)
						code = "destination_exists"
					}
				case "target-symlink":
					if exchange {
						if err := os.Remove(f.path(f.right)); err != nil {
							t.Fatal(err)
						}
					}
					if err := os.Symlink(f.root, f.path(f.right)); err != nil {
						t.Fatal(err)
					}
					if !exchange {
						code = "destination_exists"
					}
				case "target-identity":
					if !exchange {
						t.Skip("rename target absent")
					}
					f.re.Inode = "0"
				case "cross-device":
					f.right.Parent.Identity.Device = "999999"
					under := b
					b = &faultBackend{backend: b, heldFn: func(fd int) (metadata, error) {
						m, e := under.held(fd)
						if m.identity == f.re {
							return m, e
						}
						if m.identity == fileIdentity(t, f.right.Parent.File) {
							m.identity.Device = "999999"
						}
						return m, e
					}}
					code = unsupported(exchange)
				}
				called := false
				o := f.operation(exchange, b, func(context.Context) error { called = true; return nil })
				wantFailure(t, o.Run(context.Background()), code, false, false)
				if called {
					t.Fatal("fence called after failed precondition")
				}
			})
		}
	}
}

func TestFenceRechecksAndRefusal(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		for _, scenario := range []string{"source", "target", "parent-mode", "refusal", "cancel", "deadline"} {
			t.Run(map[bool]string{false: "rename/", true: "exchange/"}[exchange]+scenario, func(t *testing.T) {
				if scenario == "deadline" {
					t.Parallel()
				}
				f := newFixture(t, exchange, false)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				refused := errors.New("owner fence refusal")
				fenceEntered := false
				calls := 0
				b := &faultBackend{backend: testNative(), moveFn: func(int, string, int, string, bool) error { calls++; return nil }}
				fence := func(fenceCtx context.Context) error {
					fenceEntered = true
					switch scenario {
					case "source":
						if err := os.Rename(f.path(f.left), filepath.Join(f.root, "original")); err != nil {
							t.Fatal(err)
						}
						f.makeEntry(f.left)
					case "target":
						if exchange {
							if err := os.Rename(f.path(f.right), filepath.Join(f.root, "original")); err != nil {
								t.Fatal(err)
							}
						}
						f.makeEntry(f.right)
					case "parent-mode":
						if err := os.Chmod(f.left.Parent.File.Name(), 0777); err != nil {
							t.Fatal(err)
						}
					case "refusal":
						return refused
					case "cancel":
						cancel()
					case "deadline":
						deadline, ok := fenceCtx.Deadline()
						if !ok || fenceCtx.Err() != nil || !time.Now().Before(deadline) {
							t.Fatal("fixture deadline expired before entering owner fence")
						}
						<-fenceCtx.Done()
					}
					return nil
				}
				o := f.operation(exchange, b, fence)
				if scenario == "deadline" {
					var stop context.CancelFunc
					ctx, stop = context.WithDeadline(ctx, time.Now().Add(expiryFixtureBudget))
					defer stop()
				}
				err := o.Run(ctx)
				switch scenario {
				case "refusal":
					if err != refused {
						t.Fatalf("fence error changed: %v", err)
					}
				case "cancel":
					if err != context.Canceled {
						t.Fatal(err)
					}
				case "deadline":
					if !fenceEntered {
						t.Fatal("fixture deadline expired before entering owner fence")
					}
					if err != context.DeadlineExceeded {
						t.Fatal(err)
					}
				default:
					code := "source_replaced"
					if exchange {
						code = "exchange_precondition"
					}
					if scenario == "target" && !exchange {
						code = "destination_exists"
					}
					if scenario == "parent-mode" {
						code = "parent_replaced"
					}
					wantFailure(t, err, code, false, false)
				}
				if calls != 0 {
					t.Fatal("effect after failed fence/recheck")
				}
				wantFailure(t, o.Run(context.Background()), "operation_consumed", true, false)
			})
		}
	}
}

func TestCancellationAndDeadlineBeforeIO(t *testing.T) {
	for _, scenario := range []string{"cancel", "until", "context"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, false, false)
			calls := 0
			b := &faultBackend{backend: testNative(), heldFn: func(int) (metadata, error) { calls++; return metadata{}, nil }}
			o := f.operation(false, b, nil)
			ctx := context.Background()
			switch scenario {
			case "cancel":
				c, stop := context.WithCancel(ctx)
				stop()
				ctx = c
			case "until":
				o.until = time.Now().Add(-time.Second)
			case "context":
				c, stop := context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer stop()
				ctx = c
			}
			if err := o.Run(ctx); !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			if calls != 0 {
				t.Fatal("pre-canceled I/O")
			}
			assertEntry(t, f.left, f.le)
			assertAbsent(t, f.right)
		})
	}
}

func TestUnknownAndUnsupportedNativeErrors(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		for _, tc := range []struct {
			errno       error
			unsupported bool
		}{
			{unix.EIO, false}, {unix.EPERM, false}, {unix.ENOENT, false}, {unix.EINTR, false},
			{unix.ENOSYS, true}, {unix.ENOTSUP, true}, {unix.EXDEV, true}, {unix.EINVAL, true}, {unix.EEXIST, false},
		} {
			t.Run(map[bool]string{false: "rename/", true: "exchange/"}[exchange]+tc.errno.Error(), func(t *testing.T) {
				f := newFixture(t, exchange, false)
				b := &faultBackend{backend: testNative(), moveFn: func(int, string, int, string, bool) error { return tc.errno }}
				err := f.operation(exchange, b, nil).Run(context.Background())
				if tc.unsupported {
					code := "rename_unsupported"
					if exchange {
						code = "exchange_unsupported"
					}
					wantFailure(t, err, code, false, false)
				} else if !exchange && tc.errno == unix.EEXIST {
					wantFailure(t, err, "destination_exists", false, false)
				} else {
					code := "move_uncertain"
					if exchange {
						code = "exchange_uncertain"
					}
					wantFailure(t, err, code, true, true)
				}
			})
		}
	}
}

func TestPostEffectFailuresAreUncertain(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		for _, scenario := range []string{"cancel", "readback", "readback-io", "first-sync", "second-sync", "sync-cancel", "post-sync-replaced"} {
			t.Run(map[bool]string{false: "rename/", true: "exchange/"}[exchange]+scenario, func(t *testing.T) {
				f := newFixture(t, exchange, false)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				native := testNative()
				done := false
				syncs := 0
				b := &faultBackend{backend: native}
				b.moveFn = func(l int, ln string, r int, rn string, x bool) error {
					if err := native.move(l, ln, r, rn, x); err != nil {
						return err
					}
					done = true
					if scenario == "cancel" {
						cancel()
					}
					if scenario == "readback" {
						if err := os.Rename(f.path(f.right), filepath.Join(f.root, "moved")); err != nil {
							t.Fatal(err)
						}
						f.makeEntry(f.right)
					}
					return nil
				}
				b.namedFn = func(fd int, name string) (metadata, bool, error) {
					if done && scenario == "readback-io" {
						return metadata{}, false, unix.EIO
					}
					return native.named(fd, name)
				}
				b.syncFn = func(fd int) error {
					syncs++
					if scenario == "first-sync" && syncs == 1 || scenario == "second-sync" && syncs == 2 {
						return unix.EIO
					}
					if scenario == "sync-cancel" {
						cancel()
					}
					if scenario == "post-sync-replaced" && syncs == 2 {
						if err := os.Rename(f.path(f.right), filepath.Join(f.root, "moved")); err != nil {
							t.Fatal(err)
						}
						f.makeEntry(f.right)
					}
					return native.sync(fd)
				}
				o := f.operation(exchange, b, nil)
				err := o.Run(ctx)
				code := "move_uncertain"
				if exchange {
					code = "exchange_uncertain"
				}
				internal := scenario == "readback-io" || scenario == "first-sync" || scenario == "second-sync"
				wantFailure(t, err, code, true, internal)
				if scenario == "cancel" || scenario == "sync-cancel" {
					if !errors.Is(err, context.Canceled) {
						t.Fatal("cancellation cause lost")
					}
				}
				wantFailure(t, o.Run(context.Background()), "operation_consumed", true, false)
			})
		}
	}
}

// Leave ample time for the physical prechecks under concurrent CI load. The
// absolute deadline is chosen once before Run; no callback refreshes its budget.
const expiryFixtureBudget = 5 * time.Second

func TestOriginalDeadlineExpiresAfterDispatch(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		t.Run(map[bool]string{false: "rename", true: "exchange"}[exchange], func(t *testing.T) {
			t.Parallel()
			f := newFixture(t, exchange, false)
			native := testNative()
			var effective context.Context
			var until time.Time
			entered, succeeded := false, false
			b := &faultBackend{backend: native, moveFn: func(l int, ln string, r int, rn string, x bool) error {
				entered = true
				if effective == nil || effective.Err() != nil || !time.Now().Before(until) {
					t.Fatal("fixture deadline expired before native dispatch")
				}
				if err := native.move(l, ln, r, rn, x); err != nil {
					return err
				}
				succeeded = true
				// A real namespace effect has completed. Retain the synchronous
				// backend call until its original absolute deadline actually expires.
				<-effective.Done()
				if effective.Err() != context.DeadlineExceeded || time.Now().Before(until) {
					t.Fatal("original deadline did not expire inside native attempt")
				}
				return nil
			}}
			until = time.Now().Add(expiryFixtureBudget)
			o, err := prepare(f.left, f.right, f.le, f.re, until, func(ctx context.Context) error {
				deadline, ok := ctx.Deadline()
				if !ok || !deadline.Equal(until) {
					t.Fatal("original deadline changed before dispatch")
				}
				effective = ctx
				return nil
			}, exchange, b)
			if err != nil {
				t.Fatal(err)
			}
			err = o.Run(context.Background())
			if !entered || !succeeded {
				t.Fatalf("fixture did not witness a successful native effect: entered=%v succeeded=%v error=%v", entered, succeeded, err)
			}
			code := "move_uncertain"
			if exchange {
				code = "exchange_uncertain"
			}
			wantFailure(t, err, code, true, false)
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("post-dispatch original deadline cause lost")
			}
			t.Log("witnessed native entry before original deadline, successful effect, and real deadline expiry inside native call")
			assertEntry(t, f.right, f.le)
			if exchange {
				assertEntry(t, f.left, f.re)
			} else {
				assertAbsent(t, f.left)
			}
			wantFailure(t, o.Run(context.Background()), "operation_consumed", true, false)
		})
	}
}

func TestAtomicNoReplaceCollision(t *testing.T) {
	f := newFixture(t, false, false)
	native := testNative()
	var collision Identity
	b := &faultBackend{backend: native, moveFn: func(l int, ln string, r int, rn string, x bool) error {
		collision = f.makeEntry(f.right)
		return native.move(l, ln, r, rn, x)
	}}
	wantFailure(t, f.operation(false, b, nil).Run(context.Background()), "destination_exists", false, false)
	assertEntry(t, f.left, f.le)
	assertEntry(t, f.right, collision)
}

func TestCancellationDuringOwnedPinCleanup(t *testing.T) {
	for _, nativeError := range []error{nil, unix.EEXIST, unix.ENOSYS, unix.EIO} {
		t.Run(map[bool]string{false: "success", true: "refusal"}[nativeError != nil]+"/"+func() string {
			if nativeError == nil {
				return "nil"
			}
			return nativeError.Error()
		}(), func(t *testing.T) {
			f := newFixture(t, false, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			native := testNative()
			b := &faultBackend{backend: native, closeFn: func(fd int) { native.close(fd); cancel() }}
			if nativeError != nil {
				b.moveFn = func(int, string, int, string, bool) error { return nativeError }
			}
			err := f.operation(false, b, nil).Run(ctx)
			wantFailure(t, err, "move_uncertain", true, nativeError == unix.EIO)
			if !errors.Is(err, context.Canceled) {
				t.Fatal("lost cleanup cancellation")
			}
		})
	}
}

func TestCancellationDoesNotMaskUnexpectedNativeError(t *testing.T) {
	for _, scenario := range []string{"effect", "readback", "sync"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, false, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			native := testNative()
			done := false
			b := &faultBackend{backend: native}
			b.moveFn = func(l int, ln string, r int, rn string, x bool) error {
				if err := native.move(l, ln, r, rn, x); err != nil {
					return err
				}
				done = true
				if scenario == "effect" {
					cancel()
					return unix.EIO
				}
				return nil
			}
			b.namedFn = func(fd int, name string) (metadata, bool, error) {
				if done && scenario == "readback" {
					cancel()
					return metadata{}, false, unix.EIO
				}
				return native.named(fd, name)
			}
			b.syncFn = func(fd int) error {
				if scenario == "sync" {
					cancel()
					return unix.EIO
				}
				return native.sync(fd)
			}
			err := f.operation(false, b, nil).Run(ctx)
			wantFailure(t, err, "move_uncertain", true, true)
			if !errors.Is(err, context.Canceled) {
				t.Fatal("lost concurrent cancellation cause")
			}
		})
	}
}

func TestCopiedConcurrentRunAndSynchronousCustody(t *testing.T) {
	f := newFixture(t, false, false)
	entered := make(chan struct{})
	release := make(chan struct{})
	returned := make(chan error, 1)
	var effects atomic.Int32
	native := testNative()
	b := &faultBackend{backend: native, moveFn: func(l int, ln string, r int, rn string, x bool) error {
		effects.Add(1)
		close(entered)
		<-release
		return native.move(l, ln, r, rn, x)
	}}
	o := f.operation(false, b, nil)
	copy := *o
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { returned <- o.Run(ctx) }()
	<-entered
	wantFailure(t, copy.Run(context.Background()), "operation_consumed", true, false)
	cancel()
	select {
	case err := <-returned:
		t.Fatalf("abandoned blocked syscall: %v", err)
	default:
	}
	close(release)
	wantFailure(t, <-returned, "move_uncertain", true, false)
	if effects.Load() != 1 {
		t.Fatal("duplicate dispatch")
	}
	assertEntry(t, f.right, f.le)
	if _, err := f.left.Parent.File.Stat(); err != nil {
		t.Fatal(err)
	}
}

func TestExactBorrowedParentAndOwnerFence(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact-handle", true: "owner-refusal"}[refuse], func(t *testing.T) {
			f := newFixture(t, false, false)
			original := f.left.Parent.File.Name()
			heldPath := filepath.Join(f.root, "held-parent")
			refusal := errors.New("owner named route changed")
			o := f.operation(false, testNative(), func(context.Context) error {
				if err := os.Rename(original, heldPath); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(original, 0700); err != nil {
					t.Fatal(err)
				}
				if refuse {
					return refusal
				}
				return nil
			})
			err := o.Run(context.Background())
			if refuse {
				if err != refusal {
					t.Fatal(err)
				}
				assertAbsent(t, f.right)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertEntry(t, f.right, f.le)
			}
			// The replacement path remains empty. The primitive never reopens it;
			// refusing a named-route replacement is explicitly Release Fence's job.
			entries, err := os.ReadDir(original)
			if err != nil || len(entries) != 0 {
				t.Fatalf("replacement namespace touched: %v", err)
			}
		})
	}
}

func TestOwnerChecksAndRechecks(t *testing.T) {
	for _, scenario := range []string{"parent-owner", "source-owner", "target-owner", "parent-after-fence", "source-after-fence", "target-after-fence"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, true, false)
			native := testNative()
			pastFence := false
			effects := 0
			b := &faultBackend{backend: native}
			b.heldFn = func(fd int) (metadata, error) {
				m, e := native.held(fd)
				if scenario == "parent-owner" && m.identity == f.left.Parent.Identity || scenario == "parent-after-fence" && pastFence && m.identity == f.left.Parent.Identity {
					m.owner = false
				}
				return m, e
			}
			b.namedFn = func(fd int, name string) (metadata, bool, error) {
				m, p, e := native.named(fd, name)
				if scenario == "source-owner" && m.identity == f.le || scenario == "target-owner" && m.identity == f.re || scenario == "source-after-fence" && pastFence && m.identity == f.le || scenario == "target-after-fence" && pastFence && m.identity == f.re {
					m.owner = false
				}
				return m, p, e
			}
			b.moveFn = func(int, string, int, string, bool) error { effects++; return nil }
			o := f.operation(true, b, func(context.Context) error { pastFence = true; return nil })
			code := "exchange_precondition"
			if scenario == "parent-owner" || scenario == "parent-after-fence" {
				code = "parent_replaced"
			}
			wantFailure(t, o.Run(context.Background()), code, false, false)
			if effects != 0 {
				t.Fatal("effect despite changed owner")
			}
		})
	}
}

func TestModeSnapshotsBeforeAndAfterEffect(t *testing.T) {
	for _, after := range []bool{false, true} {
		for _, object := range []string{"parent", "left", "right"} {
			t.Run(map[bool]string{false: "fence/", true: "effect/"}[after]+object, func(t *testing.T) {
				f := newFixture(t, true, false)
				native := testNative()
				path := f.path(f.left)
				if object == "parent" {
					path = f.left.Parent.File.Name()
				}
				if object == "right" {
					path = f.path(f.right)
				}
				change := func() {
					if err := os.Chmod(path, 0750); err != nil {
						t.Fatal(err)
					}
				}
				b := &faultBackend{backend: native}
				calls := 0
				b.moveFn = func(l int, ln string, r int, rn string, x bool) error {
					calls++
					err := native.move(l, ln, r, rn, x)
					if err == nil && after {
						change()
					}
					return err
				}
				err := f.operation(true, b, func(context.Context) error {
					if !after {
						change()
					}
					return nil
				}).Run(context.Background())
				code := "exchange_precondition"
				if object == "parent" {
					code = "parent_replaced"
				}
				if after {
					code = "exchange_uncertain"
				}
				wantFailure(t, err, code, after, false)
				if !after && calls != 0 {
					t.Fatal("effect despite metadata change")
				}
			})
		}
	}
}

func TestGroupSnapshotsBeforeAndAfterEffect(t *testing.T) {
	// Negative group changes are fault-injected: these tests neither require
	// chown authority nor relax the effective-user ownership predicates.
	for _, stage := range []string{"pin", "fence", "effect", "sync"} {
		for _, object := range []string{"parent", "left", "right"} {
			t.Run(stage+"/"+object, func(t *testing.T) {
				f := newFixture(t, true, false)
				native := testNative()
				changed := false
				calls := 0
				identity := f.le
				if object == "parent" {
					identity = f.left.Parent.Identity
				}
				if object == "right" {
					identity = f.re
				}
				adjust := func(m metadata) metadata {
					if changed && m.identity == identity {
						m.gid++
					}
					return m
				}
				b := &faultBackend{backend: native}
				b.heldFn = func(fd int) (metadata, error) { m, e := native.held(fd); return adjust(m), e }
				b.namedFn = func(fd int, name string) (metadata, bool, error) {
					m, p, e := native.named(fd, name)
					return adjust(m), p, e
				}
				b.pinFn = func(fd int, name string) (int, error) {
					pin, e := native.pin(fd, name)
					if stage == "pin" {
						changed = true
					}
					return pin, e
				}
				b.moveFn = func(l int, ln string, r int, rn string, x bool) error {
					calls++
					err := native.move(l, ln, r, rn, x)
					if stage == "effect" {
						changed = true
					}
					return err
				}
				b.syncFn = func(fd int) error {
					if stage == "sync" {
						changed = true
					}
					return native.sync(fd)
				}
				err := f.operation(true, b, func(context.Context) error {
					if stage == "fence" {
						changed = true
					}
					return nil
				}).Run(context.Background())
				after := stage == "effect" || stage == "sync"
				code := "exchange_precondition"
				if object == "parent" {
					code = "parent_replaced"
				}
				if after {
					code = "exchange_uncertain"
				}
				wantFailure(t, err, code, after, false)
				if !after && calls != 0 {
					t.Fatal("effect despite group change")
				}
			})
		}
	}
}

func TestPreEffectIOFailuresAndPinRace(t *testing.T) {
	for _, scenario := range []string{"held-error", "named-error", "pin-error", "pin-missing", "pin-symlink", "cancel-during-held", "cancel-during-pin"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, false, false)
			native := testNative()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			b := &faultBackend{backend: native}
			b.heldFn = func(fd int) (metadata, error) {
				if scenario == "held-error" {
					return metadata{}, unix.EIO
				}
				if scenario == "cancel-during-held" {
					cancel()
				}
				return native.held(fd)
			}
			b.namedFn = func(fd int, name string) (metadata, bool, error) {
				if scenario == "named-error" {
					return metadata{}, false, unix.EIO
				}
				return native.named(fd, name)
			}
			b.pinFn = func(fd int, name string) (int, error) {
				if scenario == "pin-error" {
					return -1, unix.EIO
				}
				if scenario == "pin-missing" || scenario == "pin-symlink" {
					if err := os.Remove(f.path(f.left)); err != nil {
						t.Fatal(err)
					}
					if scenario == "pin-symlink" {
						if err := os.Symlink(f.root, f.path(f.left)); err != nil {
							t.Fatal(err)
						}
					}
				}
				pin, err := native.pin(fd, name)
				if scenario == "cancel-during-pin" {
					cancel()
				}
				return pin, err
			}
			called := false
			o := f.operation(false, b, func(context.Context) error { called = true; return nil })
			err := o.Run(ctx)
			if scenario == "cancel-during-held" || scenario == "cancel-during-pin" {
				if err != context.Canceled {
					t.Fatal(err)
				}
			} else {
				code := "source_replaced"
				if scenario == "held-error" {
					code = "parent_replaced"
				}
				wantFailure(t, err, code, false, scenario == "held-error" || scenario == "named-error" || scenario == "pin-error")
			}
			if called {
				t.Fatal("fence called after failed observation")
			}
			assertAbsent(t, f.right)
		})
	}
}

func TestFenceReceivesOriginalAbsoluteDeadline(t *testing.T) {
	for _, earlier := range []bool{false, true} {
		t.Run(map[bool]string{false: "operation", true: "caller"}[earlier], func(t *testing.T) {
			f := newFixture(t, false, false)
			until := time.Now().Add(time.Minute)
			ctx := context.Background()
			expected := until
			if earlier {
				var stop context.CancelFunc
				expected = time.Now().Add(30 * time.Second)
				ctx, stop = context.WithDeadline(ctx, expected)
				defer stop()
			}
			o, err := prepare(f.left, f.right, f.le, Identity{}, until, func(ctx context.Context) error {
				d, ok := ctx.Deadline()
				if !ok || !d.Equal(expected) {
					t.Fatalf("deadline reset: %v", d)
				}
				return nil
			}, false, testNative())
			if err != nil {
				t.Fatal(err)
			}
			if err := o.Run(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBorrowedLocksAndFlagsRemain(t *testing.T) {
	f := newFixture(t, false, false)
	withFD := func(file *os.File, fn func(int)) {
		raw, err := file.SyscallConn()
		if err != nil {
			t.Fatal(err)
		}
		if err := raw.Control(func(fd uintptr) { fn(int(fd)) }); err != nil {
			t.Fatal(err)
		}
	}
	var before int
	withFD(f.left.Parent.File, func(fd int) {
		var err error
		before, err = unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
			t.Fatal(err)
		}
	})
	if err := f.operation(false, testNative(), nil).Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	withFD(f.left.Parent.File, func(fd int) {
		after, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
		if err != nil || after != before {
			t.Fatalf("flags changed: %v", err)
		}
	})
	probe, err := os.Open(f.left.Parent.File.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	withFD(probe, func(fd int) {
		err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			t.Fatalf("borrowed lock lost: %v", err)
		}
	})
}

type faultBackend struct {
	backend
	heldFn  func(int) (metadata, error)
	namedFn func(int, string) (metadata, bool, error)
	moveFn  func(int, string, int, string, bool) error
	syncFn  func(int) error
	pinFn   func(int, string) (int, error)
	closeFn func(int)
}

func (b *faultBackend) close(fd int) {
	if b.closeFn != nil {
		b.closeFn(fd)
		return
	}
	b.backend.close(fd)
}

func (b *faultBackend) pin(fd int, name string) (int, error) {
	if b.pinFn != nil {
		return b.pinFn(fd, name)
	}
	return b.backend.pin(fd, name)
}

func (b *faultBackend) held(fd int) (metadata, error) {
	if b.heldFn != nil {
		return b.heldFn(fd)
	}
	return b.backend.held(fd)
}
func (b *faultBackend) named(fd int, n string) (metadata, bool, error) {
	if b.namedFn != nil {
		return b.namedFn(fd, n)
	}
	return b.backend.named(fd, n)
}
func (b *faultBackend) move(l int, ln string, r int, rn string, x bool) error {
	if b.moveFn != nil {
		return b.moveFn(l, ln, r, rn, x)
	}
	return b.backend.move(l, ln, r, rn, x)
}
func (b *faultBackend) sync(fd int) error {
	if b.syncFn != nil {
		return b.syncFn(fd)
	}
	return b.backend.sync(fd)
}

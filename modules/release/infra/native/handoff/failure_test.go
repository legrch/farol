package handoff

import (
	"context"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type lateNativeContext struct {
	context.Context
	at *time.Time
}

func (c lateNativeContext) Deadline() (time.Time, bool) { return *c.at, true }

type failureRaw struct {
	syscall.RawConn
	after func() error
}

func (r failureRaw) Control(fn func(uintptr)) error {
	return errors.Join(r.RawConn.Control(fn), r.after())
}

func checkNativeFailure(t *testing.T, err error, code Code, uncertain bool, causes ...error) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != code || !f.Internal || f.Uncertain != uncertain || err.Error() != code.Error() {
		t.Fatalf("incorrect closed failure: %#v", err)
	}
	for _, cause := range causes {
		if !errors.Is(err, cause) {
			t.Fatalf("lost cause %T behind %v", cause, err)
		}
	}
	if strings.Contains(err.Error(), "CANARY") || strings.Contains(err.Error(), "/private/") {
		t.Fatal("private cause leaked")
	}
}

func TestNativeBoundariesKeepCancellationAndLateDeadline(t *testing.T) {
	for _, boundary := range []string{"stat", "named", "root-open", "directory-open", "flags", "probe-open", "probe-flock", "lease-flock", "quit-read"} {
		for _, late := range []bool{false, true} {
			t.Run(boundary+map[bool]string{false: "/cancel", true: "/late"}[late], func(t *testing.T) {
				f := newFixture(t)
				cause := &os.PathError{Op: boundary, Path: "/private/NATIVE-CANARY", Err: unix.EIO}
				cancelCause := errors.New("CANCEL-CANARY")
				base, cancel := context.WithCancelCause(context.Background())
				defer cancel(nil)
				at := time.Now().Add(time.Hour)
				var ctx context.Context = base
				if late {
					ctx = lateNativeContext{base, &at}
				}
				calls := 0
				trigger := func() error {
					calls++
					if late {
						at = time.Now().Add(-time.Second)
					} else {
						cancel(cancelCause)
					}
					return cause
				}
				n := nativeCalls{}
				var run func(context.Context) error
				switch boundary {
				case "stat":
					n.stat = func(int, *unix.Stat_t) error { return trigger() }
					run = func(ctx context.Context) error { _, err := held(ctx, int(f.home.Fd()), ErrHomeType); return err }
				case "named":
					n.named = func(int, string, *unix.Stat_t, int) error { return trigger() }
					run = func(ctx context.Context) error {
						_, _, err := named(ctx, int(f.state.Fd()), "running.json", ErrProcessUnknown)
						return err
					}
				case "root-open":
					n.open = func(string, int, uint32) (int, error) { return -1, trigger() }
					run = func(ctx context.Context) error { _, _, err := openRoute(ctx, f.homePath); return err }
				case "directory-open":
					n.openat = func(int, string, int, uint32) (int, error) { return -1, trigger() }
					run = func(ctx context.Context) error {
						_, err := openDirectory(ctx, int(f.home.Fd()), "Library", false)
						return err
					}
				case "flags":
					n.flags = func(uintptr, int, int) (int, error) { return -1, trigger() }
					run = f.v.VerifyInherited
				case "probe-open":
					n.openat = func(fd int, name string, flags int, mode uint32) (int, error) {
						if name == "promotion.lease" {
							return -1, trigger()
						}
						return unix.Openat(fd, name, flags, mode)
					}
					run = f.v.VerifyInherited
				case "probe-flock":
					n.flock = func(int, int) error { return trigger() }
					run = f.v.VerifyInherited
				case "lease-flock":
					n.flock = func(fd, flags int) error {
						if flags&unix.LOCK_EX != 0 {
							return trigger()
						}
						return unix.Flock(fd, flags)
					}
					run = f.v.VerifyInherited
				case "quit-read":
					n.read = func(int, []byte) (int, error) { return 0, trigger() }
					run = func(ctx context.Context) error {
						data, err := readQuit(ctx, int(f.state.Fd()))
						if data != nil {
							t.Fatal("failed read returned accepted bytes")
						}
						return err
					}
				}
				ctx = context.WithValue(ctx, nativeKey{}, n)
				err := run(ctx)
				checkNativeFailure(t, err, ErrCanceled, false, cause, unix.EIO)
				if late {
					if !errors.Is(err, context.DeadlineExceeded) {
						t.Fatal("elapsed earlier deadline lost")
					}
				} else {
					if !errors.Is(err, context.Canceled) || !errors.Is(err, cancelCause) {
						t.Fatal("cancellation provenance lost")
					}
				}
				var exact *os.PathError
				if calls != 1 || !errors.As(err, &exact) || exact != cause {
					t.Fatal("native call retried or typed cause replaced")
				}
				f.assertCustody()
			})
		}
	}
}

func TestBorrowedRawConnRetainsAllCauses(t *testing.T) {
	for _, stage := range []string{"connect", "control"} {
		t.Run(stage, func(t *testing.T) {
			f := newFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			cause := &os.PathError{Op: stage, Path: "/private/RAW-CANARY", Err: unix.EIO}
			first := true
			n := nativeCalls{conn: func(file *os.File) (syscall.RawConn, error) {
				if stage == "connect" {
					cancel()
					return nil, cause
				}
				raw, err := file.SyscallConn()
				if !first {
					return raw, err
				}
				first = false
				return failureRaw{raw, func() error { cancel(); return cause }}, err
			}}
			ctx = context.WithValue(ctx, nativeKey{}, n)
			err := f.v.run(ctx, func(int, int, int) error { return ErrQuitDigest })
			checkNativeFailure(t, err, ErrCanceled, false, cause, context.Canceled)
			if stage == "control" && !errors.Is(err, ErrQuitDigest) {
				t.Fatal("Control discarded the completed nested result")
			}
			f.assertCustody()
		})
	}
}

func TestJoinedFailureRetainsCleanupUncertainty(t *testing.T) {
	cause := errors.New("CLEANUP-CANARY")
	prior := fail(ErrCleanup, true, true, cause)
	err := nativeFailure(context.Background(), ErrDescriptor, errors.Join(ErrQuitDigest, prior), unix.EIO)
	checkNativeFailure(t, err, ErrDescriptor, true, prior, cause, unix.EIO)
}

func TestNativeFailuresKeepKnownCodes(t *testing.T) {
	f := newFixture(t)
	for _, code := range []Code{ErrHomeType, ErrQuitChanged, ErrLeaseProbe, ErrDescriptor} {
		cause := &os.PathError{Op: "native", Path: "/private/NATIVE-CANARY", Err: unix.EIO}
		checkNativeFailure(t, nativeFailure(context.Background(), code, cause), code, false, cause, unix.EIO)
	}
	f.assertCustody()
}

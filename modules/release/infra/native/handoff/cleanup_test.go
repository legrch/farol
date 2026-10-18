package handoff

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// All failed-close fixtures actually close their disposable owner once, then
// inject a lost receipt. They do not reproduce a physical native Close failure.
func TestEveryOwnedVerifierCloseRefusesSuccess(t *testing.T) {
	for target := 1; target <= 4; target++ {
		t.Run(fmt.Sprint(target), func(t *testing.T) {
			f := newFixture(t)
			unchanged := borrowedWitness(t, f)
			cause := &os.PathError{Op: "close", Path: "/private/CLOSE-CANARY", Err: unix.EIO}
			calls := 0
			n := nativeCalls{close: func(fd int) error {
				if fd == int(f.home.Fd()) || fd == int(f.state.Fd()) || fd == int(f.lease.Fd()) {
					t.Fatal("borrowed descriptor closed")
				}
				calls++
				err := unix.Close(fd)
				if calls == target {
					return errors.Join(err, cause)
				}
				return err
			}}
			err := f.v.VerifyClosed(context.WithValue(context.Background(), nativeKey{}, n))
			checkNativeFailure(t, err, ErrCleanup, true, cause)
			// Route owners close before the independent lease probe opens.
			// An unconfirmed route close stops there; later owners must not open.
			want := target
			if target <= 2 {
				want = 2
			}
			if calls != want {
				t.Fatalf("cleanup omitted or repeated: %d want %d", calls, want)
			}
			unchanged()
			f.assertCustody()
		})
	}
}

func TestQuitFailureAndCleanupKeepBothCausesWithoutBytes(t *testing.T) {
	for _, primary := range []bool{false, true} {
		t.Run(fmt.Sprint(primary), func(t *testing.T) {
			f := newFixture(t)
			readErr := &os.PathError{Op: "read", Path: "/private/READ-CANARY", Err: unix.EIO}
			closeErr := errors.New("CLOSE-CANARY")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			n := nativeCalls{close: func(fd int) error { calls++; err := unix.Close(fd); cancel(); return errors.Join(err, closeErr) }}
			if primary {
				n.read = func(int, []byte) (int, error) { return 0, readErr }
			}
			ctx = context.WithValue(ctx, nativeKey{}, n)
			data, err := readQuit(ctx, int(f.state.Fd()))
			code := ErrCleanup
			if primary {
				code = ErrQuitChanged
			}
			checkNativeFailure(t, err, code, true, closeErr, context.Canceled)
			if primary && !errors.Is(err, readErr) {
				t.Fatal("cleanup replaced primary read cause")
			}
			if data != nil || calls != 1 {
				t.Fatal("cleanup accepted data or retried")
			}
			f.assertCustody()
		})
	}
}

// These cases exercise the production walk from the physical root. A host
// with a writable or foreign-owned ancestor must refuse that route before the
// injected boundary. Qualify it without a seam; only the exact ancestry refusal
// skips this native coverage. Native/cleanup failures must still fail the test.
func requirePhysicalCleanupRoute(t *testing.T, f *fixture) {
	t.Helper()
	home, state, err := openRoute(context.Background(), f.homePath)
	var cleanup error
	if state >= 0 {
		cleanup = errors.Join(cleanup, unix.Close(state))
	}
	if home >= 0 {
		cleanup = errors.Join(cleanup, unix.Close(home))
	}
	if cleanup != nil {
		t.Fatalf("physical route preflight cleanup: %v", cleanup)
	}
	if err == ErrHomeType && home < 0 && state < 0 {
		t.Skip("production temporary-route ancestry refused; physical cleanup boundary NOT RUN")
	}
	if err != nil || home < 0 || state < 0 {
		t.Fatalf("physical route preflight: %v", err)
	}
}

func TestRouteWalkConsumesEachOwnerOnceOnCloseFailure(t *testing.T) {
	f := newFixture(t)
	requirePhysicalCleanupRoute(t, f)
	// Production path and predicates, using the host's physical TMPDIR.
	// Each injected failure stops traversal; no route owner may escape.
	count := len(strings.Split(f.homePath[1:], "/")) + 3
	for target := 1; target <= count; target++ {
		t.Run(fmt.Sprint(target), func(t *testing.T) {
			active := map[int]bool{}
			opened, closed := 0, 0
			cause := errors.New("ROUTE-CLOSE-CANARY")
			register := func(fd int, err error) (int, error) {
				if fd >= 0 {
					if active[fd] {
						t.Fatal("active descriptor rebound")
					}
					active[fd] = true
					opened++
				}
				return fd, err
			}
			n := nativeCalls{
				open: func(path string, flags int, mode uint32) (int, error) {
					fd, err := unix.Open(path, flags, mode)
					return register(fd, err)
				},
				openat: func(parent int, name string, flags int, mode uint32) (int, error) {
					fd, err := unix.Openat(parent, name, flags, mode)
					return register(fd, err)
				},
				close: func(fd int) error {
					if !active[fd] {
						t.Fatal("close retried or borrowed descriptor used")
					}
					delete(active, fd)
					closed++
					err := unix.Close(fd)
					if closed == target {
						return errors.Join(err, cause)
					}
					return err
				},
			}
			home, state, err := openRoute(context.WithValue(context.Background(), nativeKey{}, n), f.homePath)
			if home >= 0 || state >= 0 { // Retain exact fixture custody even on regression.
				if home >= 0 {
					_ = unix.Close(home)
				}
				if state >= 0 {
					_ = unix.Close(state)
				}
				t.Fatal("unconfirmed route cleanup returned owners")
			}
			checkNativeFailure(t, err, ErrCleanup, true, cause)
			if len(active) != 0 || opened != closed {
				t.Fatalf("route owner leak: opened=%d closed=%d active=%d", opened, closed, len(active))
			}
			f.assertCustody()
		})
	}
}

func TestRouteErrorsRetainPrimaryAndCleanup(t *testing.T) {
	for _, point := range []string{"root-stat", "component-stat", "state-open"} {
		t.Run(point, func(t *testing.T) {
			f := newFixture(t)
			if point != "root-stat" {
				requirePhysicalCleanupRoute(t, f)
			}
			primary, cleanup := errors.New("PRIMARY-CANARY"), errors.New("CLEANUP-CANARY")
			opened, closed := 0, 0
			primaryObserved := false
			n := nativeCalls{
				open: func(path string, flags int, mode uint32) (int, error) {
					fd, err := unix.Open(path, flags, mode)
					if fd >= 0 {
						opened++
					}
					return fd, err
				},
				openat: func(parent int, name string, flags int, mode uint32) (int, error) {
					if point == "state-open" && name == "farol-next-state" {
						primaryObserved = true
						return -1, primary
					}
					fd, err := unix.Openat(parent, name, flags, mode)
					if fd >= 0 {
						opened++
					}
					return fd, err
				},
				stat: func(fd int, s *unix.Stat_t) error {
					if point == "root-stat" || point == "component-stat" && opened == 2 {
						return primary
					}
					return unix.Fstat(fd, s)
				},
			}
			// Earlier route cleanup must succeed to reach the requested failure.
			n.close = func(fd int) error {
				closed++
				err := unix.Close(fd)
				if point != "state-open" || primaryObserved {
					return errors.Join(err, cleanup)
				}
				return err
			}
			_, _, err := openRoute(context.WithValue(context.Background(), nativeKey{}, n), f.homePath)
			var failure *Failure
			if !errors.As(err, &failure) || !failure.Internal || !failure.Uncertain || !errors.Is(err, primary) || !errors.Is(err, cleanup) || opened != closed {
				t.Fatalf("route error/cleanup custody lost: %v opened=%d closed=%d", err, opened, closed)
			}
			f.assertCustody()
		})
	}
}

func TestPanicStillClosesOwnedProbeAndRouteHandles(t *testing.T) {
	f := newFixture(t)
	closes := 0
	n := nativeCalls{flock: func(int, int) error { panic("private fixture panic") }, close: func(fd int) error { closes++; return unix.Close(fd) }}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("panic not propagated")
			}
		}()
		_ = f.v.VerifyInherited(context.WithValue(context.Background(), nativeKey{}, n))
	}()
	if closes != 3 {
		t.Fatalf("panic cleanup count %d", closes)
	}
	f.assertCustody()
}

func TestCleanupHoldsSerializedNativeReturn(t *testing.T) {
	f := newFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	first := true
	n := nativeCalls{close: func(fd int) error {
		err := unix.Close(fd)
		if first {
			first = false
			close(entered)
			<-release
		}
		return err
	}}
	result := make(chan error, 1)
	go func() { result <- f.v.VerifyInherited(context.WithValue(context.Background(), nativeKey{}, n)) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("owned cleanup not reached")
	}
	select {
	case <-result:
		t.Fatal("returned before synchronous cleanup")
	default:
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := f.v.VerifyClosed(ctx); !errors.Is(err, ErrCanceled) {
		t.Fatal("waiting call not cancelled")
	}
	f.assertCustody()
	close(release)
	select {
	case err := <-result:
		must(t, err)
	case <-time.After(time.Second):
		t.Fatal("native call detached")
	}
	f.assertCustody()
}

func borrowedWitness(t *testing.T, f *fixture) func() {
	t.Helper()
	lease := int(f.lease.Fd())
	_, err := unix.Seek(lease, 17, 0)
	must(t, err)
	flags, err := unix.FcntlInt(uintptr(lease), unix.F_GETFL, 0)
	must(t, err)
	_, err = unix.FcntlInt(uintptr(lease), unix.F_SETFL, flags|unix.O_NONBLOCK)
	must(t, err)
	_, err = unix.FcntlInt(uintptr(lease), unix.F_SETFD, 0)
	must(t, err)
	alias, err := unix.Dup(lease)
	must(t, err)
	t.Cleanup(func() { must(t, unix.Close(alias)) })
	fds := []int{int(f.home.Fd()), int(f.state.Fd()), lease, alias}
	type snapshot struct {
		flags, inherit int
		offset         int64
		offsetErr      error
	}
	capture := func(fd int) snapshot {
		fl, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
		must(t, err)
		inherit, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		must(t, err)
		offset, seekErr := unix.Seek(fd, 0, 1)
		return snapshot{fl, inherit, offset, seekErr}
	}
	before := make([]snapshot, len(fds))
	for i, fd := range fds {
		before[i] = capture(fd)
	}
	return func() {
		t.Helper()
		for i, fd := range fds {
			after := capture(fd)
			if after != before[i] {
				t.Fatal("borrowed handle or alias flags/inheritance/offset changed")
			}
		}
	}
}

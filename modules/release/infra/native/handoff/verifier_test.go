package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type observerFunc func(context.Context, int, string) (ProcessState, error)

func (f observerFunc) Observe(ctx context.Context, pid int, start string) (ProcessState, error) {
	return f(ctx, pid, start)
}

type observedDoneContext struct {
	context.Context
	doneObserved chan struct{}
	once         sync.Once
}

func (c *observedDoneContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.doneObserved) })
	return c.Context.Done()
}

var absent = observerFunc(func(context.Context, int, string) (ProcessState, error) { return ProcessAbsent, nil })

const goodQuit = `{"schema":1,"at":"2026-10-15T12:00:01Z","drained":true,"unconfirmed":[]}`

type fixture struct {
	t                   *testing.T
	homePath, statePath string
	home, state, lease  *os.File
	v                   *Verifier
}

func digest(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}
func fileIdentity(t *testing.T, f *os.File) Identity {
	t.Helper()
	s, err := held(context.Background(), int(f.Fd()), ErrDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	return Identity{Device: fmt.Sprint(s.device), Inode: fmt.Sprint(s.inode)}
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, homePath: t.TempDir()}
	f.statePath = filepath.Join(f.homePath, "Library", "Application Support", "Farol Next Preview", "farol-next-state")
	if err := os.MkdirAll(f.statePath, 0700); err != nil {
		t.Fatal(err)
	}
	var err error
	f.home, err = os.Open(f.homePath)
	if err != nil {
		t.Fatal(err)
	}
	f.state, err = os.Open(f.statePath)
	if err != nil {
		t.Fatal(err)
	}
	f.lease, err = os.OpenFile(filepath.Join(f.statePath, "promotion.lease"), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.lease.Close(); f.state.Close(); f.home.Close() })
	if err = unix.Flock(int(f.lease.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	f.writeQuit(goodQuit)
	f.v, err = New(f.homePath, f.home, f.state, f.lease, Expected{StateIdentity: fileIdentity(t, f.state), LeaseIdentity: fileIdentity(t, f.lease), PID: 42, ProcessStart: "Thu Oct 15 12:00:00 2026", StartedAt: "2026-10-15T12:00:00Z", LastQuitSHA256: digest(goodQuit)}, absent, func() time.Time { return time.Date(2026, 10, 15, 12, 1, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	// Fixture only: the managed Cloud root is UID 65534, not root/effective
	// owner. Reopen the disposable home directly, while still exercising every
	// fixed state component. Production openRoute is separately tested below.
	f.v.reopen = fixtureRoute
	return f
}

func fixtureRoute(ctx context.Context, path string) (int, int, error) {
	if err := canceled(ctx); err != nil {
		return -1, -1, err
	}
	home, err := unix.Open(path, dirFlags, 0)
	if err != nil {
		return -1, -1, ErrHomeType
	}
	parent := home
	for _, part := range []string{"Library", "Application Support", "Farol Next Preview", "farol-next-state"} {
		next, err := openDirectory(ctx, parent, part, false)
		if parent != home {
			unix.Close(parent)
		}
		if err != nil {
			unix.Close(home)
			return -1, -1, err
		}
		parent = next
	}
	return home, parent, nil
}

func (f *fixture) writeQuit(data string) {
	f.t.Helper()
	if err := os.WriteFile(filepath.Join(f.statePath, "last-quit.json"), []byte(data), 0600); err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) boundQuit(data string) {
	f.writeQuit(data)
	f.v.expected.LastQuitSHA256 = digest(data)
}
func (f *fixture) assertCustody() {
	f.t.Helper()
	for _, file := range []*os.File{f.home, f.state, f.lease} {
		if _, err := file.Stat(); err != nil {
			f.t.Fatalf("borrowed descriptor closed: %v", err)
		}
	}
	probe, err := os.Open(filepath.Join(f.statePath, "promotion.lease"))
	if err != nil {
		f.t.Fatal(err)
	}
	defer probe.Close()
	err = unix.Flock(int(probe.Fd()), unix.LOCK_SH|unix.LOCK_NB)
	if err != unix.EWOULDBLOCK && err != unix.EAGAIN {
		f.t.Fatalf("borrowed exclusive lock lost: %v", err)
	}
}
func wantCode(t *testing.T, err error, want Code) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

func TestSuccessfulBorrowedCustody(t *testing.T) {
	f := newFixture(t)
	leaseFD := f.lease.Fd()
	initialFlags, err := unix.FcntlInt(leaseFD, unix.F_GETFL, 0)
	must(t, err)
	_, err = unix.FcntlInt(leaseFD, unix.F_SETFL, initialFlags|unix.O_NONBLOCK)
	must(t, err)
	// Simulate an inherited descriptor's cleared CLOEXEC flag. Capture the raw
	// value once before verification so later os.File.Fd calls cannot hide a
	// verifier mutation of nonblocking or inheritability flags.
	_, err = unix.FcntlInt(leaseFD, unix.F_SETFD, 0)
	must(t, err)
	if _, err := f.lease.Seek(17, 0); err != nil {
		t.Fatal(err)
	}
	flags, _ := unix.FcntlInt(leaseFD, unix.F_GETFL, 0)
	fdflags, _ := unix.FcntlInt(leaseFD, unix.F_GETFD, 0)
	for _, verify := range []func(context.Context) error{f.v.VerifyInherited, f.v.VerifyClosed} {
		if err := verify(context.Background()); err != nil {
			t.Fatal(err)
		}
		f.assertCustody()
	}
	position, err := f.lease.Seek(0, 1)
	if err != nil || position != 17 {
		t.Fatalf("borrowed offset changed: %d %v", position, err)
	}
	afterFlags, _ := unix.FcntlInt(leaseFD, unix.F_GETFL, 0)
	afterFDFlags, _ := unix.FcntlInt(leaseFD, unix.F_GETFD, 0)
	if flags != afterFlags || fdflags != afterFDFlags {
		t.Fatal("borrowed flags changed")
	}
}

func TestIndependentDescriptionAndAccess(t *testing.T) {
	t.Run("unlocked", func(t *testing.T) {
		f := newFixture(t)
		if err := unix.Flock(int(f.lease.Fd()), unix.LOCK_UN); err != nil {
			t.Fatal(err)
		}
		wantCode(t, f.v.VerifyInherited(context.Background()), ErrLeaseUnheld)
		probe, err := os.OpenFile(filepath.Join(f.statePath, "promotion.lease"), os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer probe.Close()
		if err = unix.Flock(int(probe.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
			t.Fatalf("verifier acquired an unlocked lease: %v", err)
		}
		if _, err = f.lease.Stat(); err != nil {
			t.Fatal("borrowed descriptor closed")
		}
	})
	t.Run("shared", func(t *testing.T) {
		f := newFixture(t)
		if err := unix.Flock(int(f.lease.Fd()), unix.LOCK_SH|unix.LOCK_NB); err != nil {
			t.Fatal(err)
		}
		wantCode(t, f.v.VerifyInherited(context.Background()), ErrLeaseUnheld)
		probe, err := os.Open(filepath.Join(f.statePath, "promotion.lease"))
		if err != nil {
			t.Fatal(err)
		}
		defer probe.Close()
		if err = unix.Flock(int(probe.Fd()), unix.LOCK_SH|unix.LOCK_NB); err != nil {
			t.Fatal("shared lock was upgraded")
		}
		if err = unix.Flock(int(probe.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK && err != unix.EAGAIN {
			t.Fatalf("shared custody changed: %v", err)
		}
	})
	t.Run("crossed", func(t *testing.T) {
		f := newFixture(t)
		other, err := os.OpenFile(filepath.Join(f.statePath, "promotion.lease"), os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		f.v.lease = other
		wantCode(t, f.v.VerifyInherited(context.Background()), ErrLeaseCrossed)
		f.assertCustody()
	})
	t.Run("read_only", func(t *testing.T) {
		f := newFixture(t)
		other, err := os.Open(filepath.Join(f.statePath, "promotion.lease"))
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		f.v.lease = other
		wantCode(t, f.v.VerifyInherited(context.Background()), ErrLeaseAccess)
		f.assertCustody()
	})
	t.Run("duplicate_same_description", func(t *testing.T) {
		f := newFixture(t)
		fd, err := unix.Dup(int(f.lease.Fd()))
		if err != nil {
			t.Fatal(err)
		}
		other := os.NewFile(uintptr(fd), "fixture-duplicate")
		defer other.Close()
		f.v.lease = other
		if err = f.v.VerifyInherited(context.Background()); err != nil {
			t.Fatal(err)
		}
		f.assertCustody()
	})
}

func TestLeaseIdentityRefusals(t *testing.T) {
	tests := []struct {
		name   string
		change func(*fixture)
		code   Code
	}{
		{"mode", func(f *fixture) { must(t, os.Chmod(filepath.Join(f.statePath, "promotion.lease"), 0640)) }, ErrLeaseIdentity},
		{"special_mode", func(f *fixture) { must(t, unix.Fchmod(int(f.lease.Fd()), 04600)) }, ErrLeaseIdentity},
		{"hardlink", func(f *fixture) {
			must(t, os.Link(filepath.Join(f.statePath, "promotion.lease"), filepath.Join(f.statePath, "other")))
		}, ErrLeaseIdentity},
		{"replacement", func(f *fixture) {
			must(t, os.Rename(filepath.Join(f.statePath, "promotion.lease"), filepath.Join(f.statePath, "old")))
			must(t, os.WriteFile(filepath.Join(f.statePath, "promotion.lease"), nil, 0600))
		}, ErrLeaseIdentity},
		{"symlink", func(f *fixture) {
			must(t, os.Rename(filepath.Join(f.statePath, "promotion.lease"), filepath.Join(f.statePath, "old")))
			must(t, os.Symlink("old", filepath.Join(f.statePath, "promotion.lease")))
		}, ErrLeaseIdentity},
		{"fifo", func(f *fixture) {
			must(t, os.Remove(filepath.Join(f.statePath, "promotion.lease")))
			must(t, unix.Mkfifo(filepath.Join(f.statePath, "promotion.lease"), 0600))
		}, ErrLeaseIdentity},
		{"directory", func(f *fixture) {
			must(t, os.Remove(filepath.Join(f.statePath, "promotion.lease")))
			must(t, os.Mkdir(filepath.Join(f.statePath, "promotion.lease"), 0700))
		}, ErrLeaseIdentity},
		{"missing", func(f *fixture) { must(t, os.Remove(filepath.Join(f.statePath, "promotion.lease"))) }, ErrLeaseIdentity},
		{"bound_identity", func(f *fixture) { f.v.expected.LeaseIdentity.Inode = "9007199254740993" }, ErrLeaseIdentity},
		{"state_identity", func(f *fixture) { f.v.expected.StateIdentity.Device = "18446744073709551616" }, ErrStateChanged},
		{"state_mode", func(f *fixture) { must(t, os.Chmod(f.statePath, 0750)) }, ErrStateChanged},
		{"state_replacement", func(f *fixture) {
			must(t, os.Rename(f.statePath, f.statePath+"-old"))
			must(t, os.Mkdir(f.statePath, 0700))
		}, ErrStateChanged},
		{"state_symlink", func(f *fixture) {
			must(t, os.Rename(f.statePath, f.statePath+"-old"))
			must(t, os.Symlink(f.statePath+"-old", f.statePath))
		}, ErrPathType},
		{"home_replacement", func(f *fixture) {
			must(t, os.Rename(f.homePath, f.homePath+"-old"))
			must(t, os.Mkdir(f.homePath, 0700))
			must(t, os.MkdirAll(f.statePath, 0700))
			t.Cleanup(func() { os.RemoveAll(f.homePath + "-old") })
		}, ErrStateChanged},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			tc.change(f)
			wantCode(t, f.v.VerifyInherited(context.Background()), tc.code)
			for _, file := range []*os.File{f.home, f.state, f.lease} {
				if _, err := file.Stat(); err != nil {
					t.Fatalf("borrowed fd closed: %v", err)
				}
			}
		})
	}
}
func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestClosedRequiresExplicitAbsence(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state ProcessState
		err   error
		want  Code
	}{
		{"live", ProcessPresent, nil, ErrProcessRunning}, {"reused", ProcessPresent, nil, ErrProcessRunning},
		{"unknown", ProcessUnknown, nil, ErrProcessUnknown}, {"invalid", ProcessState(255), nil, ErrProcessUnknown},
		{"absence_with_error", ProcessAbsent, errors.New("private-observer-detail"), ErrProcessUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.v.process = observerFunc(func(ctx context.Context, pid int, start string) (ProcessState, error) {
				if pid != 42 || start != f.v.expected.ProcessStart {
					t.Fatal("lost correlation")
				}
				return tc.state, tc.err
			})
			err := f.v.VerifyClosed(context.Background())
			wantCode(t, err, tc.want)
			if err.Error() != tc.want.Error() {
				t.Fatal("outer refusal changed")
			}
			if tc.err == nil && err != tc.want {
				t.Fatal("observation without error changed simple code contract")
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatal("observer cause lost")
			}
			f.assertCustody()
		})
	}
	t.Run("marker", func(t *testing.T) {
		f := newFixture(t)
		must(t, os.Symlink("missing", filepath.Join(f.statePath, "running.json")))
		wantCode(t, f.v.VerifyClosed(context.Background()), ErrRunningMarker)
		f.assertCustody()
	})
}

func TestObserverFailureProvenance(t *testing.T) {
	for _, cancelDuring := range []bool{false, true} {
		for _, state := range []ProcessState{ProcessUnknown, ProcessAbsent, ProcessPresent} {
			t.Run(fmt.Sprintf("cancel=%t/state=%d", cancelDuring, state), func(t *testing.T) {
				f := newFixture(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				sentinel := errors.New("private original-child cleanup uncertainty")
				cause := &os.PathError{Op: "observe", Path: "/private/process-input", Err: sentinel}
				calls := 0
				f.v.process = observerFunc(func(got context.Context, _ int, _ string) (ProcessState, error) {
					calls++
					if got != ctx {
						t.Fatal("observer context changed")
					}
					if cancelDuring {
						cancel()
					}
					return state, cause
				})
				fd := f.lease.Fd()
				flags, e := unix.FcntlInt(fd, unix.F_GETFL, 0)
				must(t, e)
				descriptorFlags, e := unix.FcntlInt(fd, unix.F_GETFD, 0)
				must(t, e)
				_, e = f.lease.Seek(17, 0)
				must(t, e)
				err := f.v.VerifyClosed(ctx)
				want := ErrProcessUnknown
				if cancelDuring {
					want = ErrCanceled
				}
				wantCode(t, err, want)
				var typed *os.PathError
				if calls != 1 || !errors.As(err, &typed) || typed != cause || !errors.Is(err, cause) || !errors.Is(err, sentinel) {
					t.Fatal("exact observer failure was lost or observation retried")
				}
				if err.Error() != want.Error() || errors.Is(err, context.Canceled) != cancelDuring {
					t.Fatal("outer refusal or cancellation cause changed")
				}
				afterFlags, e := unix.FcntlInt(fd, unix.F_GETFL, 0)
				must(t, e)
				afterDescriptorFlags, e := unix.FcntlInt(fd, unix.F_GETFD, 0)
				must(t, e)
				position, e := f.lease.Seek(0, 1)
				must(t, e)
				if afterFlags != flags || afterDescriptorFlags != descriptorFlags || position != 17 {
					t.Fatal("observer refusal changed borrowed flags or offset")
				}
				f.assertCustody()
			})
		}
	}
}

func TestQuitBoundBytesAndMetadata(t *testing.T) {
	tests := []struct {
		name   string
		change func(*fixture)
		want   Code
	}{
		{"missing", func(f *fixture) { must(t, os.Remove(filepath.Join(f.statePath, "last-quit.json"))) }, ErrQuitChanged},
		{"public", func(f *fixture) { must(t, os.Chmod(filepath.Join(f.statePath, "last-quit.json"), 0644)) }, ErrQuitChanged},
		{"hardlink", func(f *fixture) {
			must(t, os.Link(filepath.Join(f.statePath, "last-quit.json"), filepath.Join(f.statePath, "quit-link")))
		}, ErrQuitChanged},
		{"symlink", func(f *fixture) {
			must(t, os.Rename(filepath.Join(f.statePath, "last-quit.json"), filepath.Join(f.statePath, "quit-old")))
			must(t, os.Symlink("quit-old", filepath.Join(f.statePath, "last-quit.json")))
		}, ErrQuitChanged},
		{"fifo", func(f *fixture) {
			must(t, os.Remove(filepath.Join(f.statePath, "last-quit.json")))
			must(t, unix.Mkfifo(filepath.Join(f.statePath, "last-quit.json"), 0600))
		}, ErrQuitChanged},
		{"directory", func(f *fixture) {
			must(t, os.Remove(filepath.Join(f.statePath, "last-quit.json")))
			must(t, os.Mkdir(filepath.Join(f.statePath, "last-quit.json"), 0700))
		}, ErrQuitChanged},
		{"empty", func(f *fixture) { f.writeQuit("") }, ErrQuitChanged},
		{"oversize", func(f *fixture) { f.writeQuit(strings.Repeat(" ", 8193)) }, ErrQuitChanged},
		{"changed_digest", func(f *fixture) { f.writeQuit(goodQuit + "\n") }, ErrQuitDigest},
		{"future", func(f *fixture) { f.boundQuit(strings.Replace(goodQuit, "12:00:01", "12:01:01", 1)) }, ErrQuitStale},
		{"equal_start", func(f *fixture) { f.boundQuit(strings.Replace(goodQuit, "12:00:01", "12:00:00", 1)) }, ErrQuitStale},
		{"stale", func(f *fixture) { f.boundQuit(strings.Replace(goodQuit, "12:00:01", "11:59:59", 1)) }, ErrQuitStale},
		{"zero_clock", func(f *fixture) { f.v.now = func() time.Time { return time.Time{} } }, ErrClock},
		{"out_of_range_clock", func(f *fixture) { f.v.now = func() time.Time { return time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC) } }, ErrClock},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			tc.change(f)
			wantCode(t, f.v.VerifyClosed(context.Background()), tc.want)
			f.assertCustody()
		})
	}
	t.Run("full_record_limit", func(t *testing.T) {
		f := newFixture(t)
		f.boundQuit(goodQuit + strings.Repeat(" ", maxRecord-len(goodQuit)))
		if err := f.v.VerifyClosed(context.Background()); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("timezone_fraction", func(t *testing.T) {
		f := newFixture(t)
		f.boundQuit(strings.Replace(goodQuit, "2026-10-15T12:00:01Z", "2026-10-15T14:00:01.123456789+02:00", 1))
		if err := f.v.VerifyClosed(context.Background()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestMalformedQuitReceipt(t *testing.T) {
	tests := []string{
		`null`, `[]`, `true`, goodQuit + `{}`, `{"schema":1`,
		strings.Replace(goodQuit, `"schema":1`, `"schema":1,"schema":1`, 1),
		strings.Replace(goodQuit, `"schema":1`, `"schema":1,"\u0073chema":1`, 1),
		strings.Replace(goodQuit, `"schema":1`, `"schema":true`, 1),
		strings.Replace(goodQuit, `"schema":1`, `"schema":1.0`, 1),
		strings.Replace(goodQuit, `"schema":1`, `"schema":1e0`, 1),
		strings.Replace(goodQuit, `"schema":1`, `"schema":null`, 1),
		strings.Replace(goodQuit, `"drained":true`, `"drained":null`, 1),
		strings.Replace(goodQuit, `"drained":true`, `"drained":1`, 1),
		strings.Replace(goodQuit, `"unconfirmed":[]`, `"unconfirmed":null`, 1),
		strings.Replace(goodQuit, `"unconfirmed":[]`, `"unconfirmed":[null]`, 1),
		strings.Replace(goodQuit, `"unconfirmed":[]`, `"unexpected":[]`, 1),
		strings.Replace(goodQuit, `"at":"2026-10-15T12:00:01Z"`, `"at":null`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:01`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:01+24:00`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:01+00:60`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:01,1Z`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:01.1234567890Z`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `0000-10-15T12:00:01Z`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:60Z`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `\ud800`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `\udc00`, 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, string([]byte{0xff}), 1),
		strings.Replace(goodQuit, `2026-10-15T12:00:01Z`, `2026-10-15T12:00:01Z\u0000`, 1),
	}
	for i, data := range tests {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			f := newFixture(t)
			f.boundQuit(data)
			err := f.v.VerifyClosed(context.Background())
			if err == nil {
				t.Fatalf("accepted malformed receipt %q", data)
			}
			if _, ok := err.(Code); !ok {
				t.Fatalf("unclassified error: %v", err)
			}
			f.assertCustody()
		})
	}
}

func TestCancellationAndDependencies(t *testing.T) {
	f := newFixture(t)
	wantCode(t, f.v.VerifyClosed(nil), ErrDependency)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	wantCode(t, f.v.VerifyInherited(ctx), ErrCanceled)
	f.assertCustody()
	f.v.process = observerFunc(func(ctx context.Context, _ int, _ string) (ProcessState, error) { cancel(); return ProcessAbsent, nil })
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	if err := f.v.VerifyClosed(ctx); err != ErrCanceled {
		t.Fatalf("successful observer cancellation changed simple code contract: %v", err)
	}
	f.assertCustody()
	t.Run("closed_borrowed_file", func(t *testing.T) {
		f := newFixture(t)
		must(t, f.lease.Close())
		wantCode(t, f.v.VerifyInherited(context.Background()), ErrDescriptor)
	})
	t.Run("nil_receiver", func(t *testing.T) {
		var v *Verifier
		wantCode(t, v.VerifyInherited(context.Background()), ErrDependency)
	})
	t.Run("clock_cancellation", func(t *testing.T) {
		f := newFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		f.v.now = func() time.Time { cancel(); return time.Now() }
		wantCode(t, f.v.VerifyClosed(ctx), ErrCanceled)
		f.assertCustody()
	})
}

func TestConcurrentCallsAndCancelableWait(t *testing.T) {
	f := newFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f.v.VerifyClosed(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	f.assertCustody()
	// Independent verifiers borrow the same retained description. Neither has
	// a Close operation and neither owns the other instance's lifetime.
	v2, err := New(f.homePath, f.home, f.state, f.lease, f.v.expected, absent, f.v.now)
	must(t, err)
	v2.reopen = fixtureRoute
	for _, v := range []*Verifier{f.v, v2} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := v.VerifyInherited(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	f.assertCustody()
	entered, release := make(chan struct{}), make(chan struct{})
	f.v.process = observerFunc(func(context.Context, int, string) (ProcessState, error) {
		close(entered)
		<-release
		return ProcessAbsent, nil
	})
	done := make(chan error, 1)
	go func() { done <- f.v.VerifyClosed(context.Background()) }()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	watched := &observedDoneContext{Context: ctx, doneObserved: make(chan struct{})}
	waited := make(chan error, 1)
	go func() { waited <- f.v.VerifyInherited(watched) }()
	// The observer above occupies the gate. Done being evaluated establishes
	// that this second call reached the cancelable gate selection.
	<-watched.doneObserved
	cancel()
	wantCode(t, <-waited, ErrCanceled)
	close(release)
	must(t, <-done)
	f.assertCustody()
}

func TestNewRejectsMalformedBindings(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"", "/", "relative", "/one/", "/one//two", "/one/./two", "/one/../two", "/one\x00two", "/" + strings.Repeat("x", 256)} {
		_, err := New(path, f.home, f.state, f.lease, f.v.expected, absent, f.v.now)
		wantCode(t, err, ErrInput)
	}
	for _, part := range []string{"", "00", "01", "-1", "+1", "1.0", "１２", strings.Repeat("9", 31)} {
		e := f.v.expected
		e.StateIdentity.Device = part
		_, err := New(f.homePath, f.home, f.state, f.lease, e, absent, f.v.now)
		wantCode(t, err, ErrInput)
	}
	e := f.v.expected
	e.StateIdentity.Device = "9007199254740993"
	v, err := New(f.homePath, f.home, f.state, f.lease, e, absent, f.v.now)
	must(t, err)
	if v.expected.StateIdentity.Device != e.StateIdentity.Device {
		t.Fatal("identity lost precision")
	}
	for _, change := range []func(*Expected){func(e *Expected) { e.PID = 1 }, func(e *Expected) { e.ProcessStart = "" }, func(e *Expected) { e.ProcessStart = "start\x00" }, func(e *Expected) { e.StartedAt = "2026-10-15T12:00:00" }, func(e *Expected) { e.LastQuitSHA256 = strings.Repeat("A", 64) }} {
		e := f.v.expected
		change(&e)
		_, err := New(f.homePath, f.home, f.state, f.lease, e, absent, f.v.now)
		wantCode(t, err, ErrInput)
	}
	_, err = New(f.homePath, nil, f.state, f.lease, f.v.expected, absent, f.v.now)
	wantCode(t, err, ErrDependency)
	_, err = New(f.homePath, f.home, f.state, f.lease, f.v.expected, nil, f.v.now)
	wantCode(t, err, ErrDependency)
	var typedNil observerFunc
	_, err = New(f.homePath, f.home, f.state, f.lease, f.v.expected, typedNil, f.v.now)
	wantCode(t, err, ErrDependency)
	_, err = New(f.homePath, f.home, f.state, f.lease, f.v.expected, absent, nil)
	wantCode(t, err, ErrDependency)
}

func TestProductionRouteRefusesUnsafeCloudAncestors(t *testing.T) {
	f := newFixture(t)
	var root unix.Stat_t
	must(t, unix.Stat("/", &root))
	if root.Uid == 0 || root.Uid == uint32(unix.Geteuid()) {
		t.Skip("host root ownership does not exercise Cloud UID mismatch")
	}
	f.v.reopen = openRoute
	wantCode(t, f.v.VerifyInherited(context.Background()), ErrHomeType)
	f.assertCustody()
}

func TestPhysicalComponentChecks(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(string) error
	}{
		{"symlink", func(p string) error { return os.Symlink("target", p) }},
		{"writable", func(p string) error {
			if err := os.Mkdir(p, 0700); err != nil {
				return err
			}
			return os.Chmod(p, 0770)
		}},
		{"file", func(p string) error { return os.WriteFile(p, nil, 0600) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			must(t, tc.make(filepath.Join(dir, "child")))
			parent, err := os.Open(dir)
			must(t, err)
			defer parent.Close()
			fd, err := openDirectory(context.Background(), int(parent.Fd()), "child", true)
			if fd >= 0 {
				unix.Close(fd)
			}
			wantCode(t, err, ErrHomeType)
		})
	}
}

func TestProbeUncertaintyNeverProvesCustody(t *testing.T) {
	f := newFixture(t)
	inherited, err := held(context.Background(), int(f.lease.Fd()), ErrLeaseIdentity)
	must(t, err)
	// An unavailable directory is an observation failure, never evidence that
	// the independent shared probe conflicted with the inherited lock.
	wantCode(t, checkInheritedProbe(context.Background(), -1, inherited), ErrLeaseProbe)
	f.assertCustody()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	wantCode(t, checkInheritedProbe(ctx, int(f.state.Fd()), inherited), ErrCanceled)
	f.assertCustody()
}

func TestQuitSnapshotDetectsReplacementAndMetadataChanges(t *testing.T) {
	for _, kind := range []string{"named_replacement", "size", "mtime", "ctime"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			before, exists, err := named(context.Background(), int(f.state.Fd()), "last-quit.json", ErrQuitChanged)
			must(t, err)
			if !exists {
				t.Fatal("missing fixture receipt")
			}
			fd, err := unix.Openat(int(f.state.Fd()), "last-quit.json", readFlags, 0)
			must(t, err)
			defer unix.Close(fd)
			path := filepath.Join(f.statePath, "last-quit.json")
			switch kind {
			case "named_replacement":
				must(t, os.Rename(path, path+"-old"))
				must(t, os.WriteFile(path, []byte(goodQuit), 0600))
			case "size":
				f.writeQuit(goodQuit + "\n")
			case "mtime":
				must(t, os.Chtimes(path, time.Unix(1, 0), time.Unix(2, 0)))
			case "ctime":
				// Same bytes, size, mode and exact mtime still do not retain the
				// snapshot when the kernel change timestamp has advanced.
				must(t, os.Chmod(path, 0400))
				must(t, os.Chmod(path, 0600))
				must(t, unix.UtimesNanoAt(int(f.state.Fd()), "last-quit.json", []unix.Timespec{{Sec: 1}, {Sec: before.mtimeSec, Nsec: before.mtimeNano}}, unix.AT_SYMLINK_NOFOLLOW))
				current, _, err := named(context.Background(), int(f.state.Fd()), "last-quit.json", ErrQuitChanged)
				must(t, err)
				if current.ctimeSec == before.ctimeSec && current.ctimeNano == before.ctimeNano {
					t.Fatal("fixture did not advance ctime")
				}
				if current.size != before.size || current.mode != before.mode || current.mtimeSec != before.mtimeSec || current.mtimeNano != before.mtimeNano {
					t.Fatal("fixture changed more than the ctime binding")
				}
			}
			_, err = readPinnedQuit(context.Background(), int(f.state.Fd()), fd, before)
			wantCode(t, err, ErrQuitChanged)
			f.assertCustody()
		})
	}
	t.Run("read_only_private_receipt", func(t *testing.T) {
		f := newFixture(t)
		must(t, os.Chmod(filepath.Join(f.statePath, "last-quit.json"), 0400))
		must(t, f.v.VerifyClosed(context.Background()))
		f.assertCustody()
	})
}

func TestStrictUnicodePairHandling(t *testing.T) {
	for _, raw := range []string{`"\ud800\udc00"`, `"\\ud800"`, `{"key":"text"}`} {
		if !strictUnicode([]byte(raw)) {
			t.Fatalf("rejected valid JSON Unicode %s", raw)
		}
	}
	for _, raw := range []string{`"\ud800"`, `"\udc00"`, `"\ud800\u0000"`, `"\ud800x"`, `"\ud800\\udc00"`} {
		if strictUnicode([]byte(raw)) {
			t.Fatalf("accepted unpaired surrogate %s", raw)
		}
	}
}

func FuzzQuitTimestamp(f *testing.F) {
	for _, data := range []string{goodQuit, `{"schema":1,"at":"\ud800","drained":true,"unconfirmed":[]}`, `null`, `{"at":"\\\""}`, "\xff"} {
		f.Add([]byte(data))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		at, err := quitTimestamp(data)
		if err != nil {
			if _, ok := err.(Code); !ok {
				t.Fatalf("unclassified refusal: %v", err)
			}
			return
		}
		if at.Year() < 1 || at.Year() > 9999 || len(data) > maxRecord {
			t.Fatal("invalid timestamp admitted")
		}
	})
}

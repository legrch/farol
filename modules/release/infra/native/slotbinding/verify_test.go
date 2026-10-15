package slotbinding

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"golang.org/x/sys/unix"
)

func verificationFixture(t *testing.T) (fixtureDir, *Verifier) {
	t.Helper()
	f := setup(t)
	decision(t, f, context.Background(), port.SlotBindingConfirmed)
	var st unix.Stat_t
	if err := unix.Fstat(int(f.fd.Fd()), &st); err != nil {
		t.Fatal(err)
	}
	id := Identity{strconv.FormatUint(uint64(st.Dev), 10), strconv.FormatUint(st.Ino, 10)}
	v, err := NewVerifier(f.fd, id, f.data, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	return f, v
}

func verificationCode(t *testing.T, err error, code string, internal bool) {
	t.Helper()
	f, ok := err.(*VerificationFailure)
	if !ok || f == nil || f.Code != "slot_binding_"+code || f.Internal != internal || f.Error() != f.Code {
		t.Fatalf("verification %#v want %s internal=%v", err, code, internal)
	}
}

func TestExpectedSlotReadIsIndependentAndKeepsBorrowedCustody(t *testing.T) {
	f, v := verificationFixture(t)
	f.data[0] = 'X'
	fd := int(f.fd.Fd())
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		t.Fatal(err)
	}
	descriptorFlags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	// Darwin reports a sticky FHASLOCK status bit once a description has been
	// flocked, so the baseline must include the fixture's own lock.
	if flags, err = unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := v.Verify(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	got, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil || got != flags {
		t.Fatal("borrowed descriptor reconfigured")
	}
	got, err = unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil || got != descriptorFlags {
		t.Fatal("borrowed descriptor inheritance reconfigured")
	}
	other, err := os.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err = unix.Flock(int(other.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK && err != unix.EAGAIN {
		t.Fatal("borrowed lease released", err)
	}
}

func TestSlotVerificationRefusesChangedOrUnsafeRecords(t *testing.T) {
	for _, kind := range []string{"missing", "symlink", "hardlink", "directory", "mode", "empty", "oversized", "mismatch", "replaced", "changed-during-read", "removed-at-readback", "parent-mode", "parent-mode-at-readback", "wrong-parent"} {
		t.Run(kind, func(t *testing.T) {
			f, v := verificationFixture(t)
			code := "type"
			switch kind {
			case "missing", "symlink", "directory":
				if err := os.Remove(f.file()); err != nil {
					t.Fatal(err)
				}
				if kind == "missing" {
					code = "missing"
				}
				if kind == "symlink" {
					if err := os.Symlink("outside", f.file()); err != nil {
						t.Fatal(err)
					}
				}
				if kind == "directory" {
					if err := os.Mkdir(f.file(), 0700); err != nil {
						t.Fatal(err)
					}
				}
			case "hardlink":
				if err := os.Link(f.file(), filepath.Join(f.dir, "alias")); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(f.file(), 0640); err != nil {
					t.Fatal(err)
				}
			case "empty", "oversized":
				data := []byte{}
				if kind == "oversized" {
					data = []byte(strings.Repeat("x", 8193))
				}
				if err := os.WriteFile(f.file(), data, 0600); err != nil {
					t.Fatal(err)
				}
			case "mismatch":
				code = "mismatch"
				if err := os.WriteFile(f.file(), []byte(strings.Replace(string(v.expected), "shared", "legacy", 1)), 0600); err != nil {
					t.Fatal(err)
				}
			case "parent-mode":
				code = "directory"
				if err := os.Chmod(f.dir, 0750); err != nil {
					t.Fatal(err)
				}
			case "wrong-parent":
				code = "directory"
				v.identity.Inode = "0"
			case "parent-mode-at-readback":
				// identity() retains mode/uid/gid, so a parent opened to other
				// users during the observation refuses instead of confirming.
				code = "changed"
				v.step = func(at string) {
					if at != "parent-readback" {
						return
					}
					if err := os.Chmod(f.dir, 0777); err != nil {
						t.Fatal(err)
					}
				}
			case "replaced", "changed-during-read", "removed-at-readback":
				code = "changed"
				label := "open"
				if kind == "changed-during-read" {
					label = "read"
				}
				if kind == "removed-at-readback" {
					label = "readback"
				}
				done := false
				v.step = func(at string) {
					if done || at != label {
						return
					}
					done = true
					if kind == "changed-during-read" {
						if err := os.WriteFile(f.file(), []byte("changed"), 0600); err != nil {
							t.Fatal(err)
						}
						return
					}
					if err := os.Rename(f.file(), f.file()+"-old"); err != nil {
						t.Fatal(err)
					}
					if kind == "replaced" {
						if err := os.WriteFile(f.file(), v.expected, 0600); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
			verificationCode(t, v.Verify(context.Background()), code, false)
		})
	}
}

type slotLaggingContext struct {
	context.Context
	until time.Time
}

func (c slotLaggingContext) Deadline() (time.Time, bool) { return c.until, true }
func (slotLaggingContext) Done() <-chan struct{}         { return nil }
func (slotLaggingContext) Err() error                    { return nil }

func TestSlotReadDeadlinesAndNativeCancellationCauses(t *testing.T) {
	_, v := verificationFixture(t)
	called := false
	v.step = func(string) { called = true }
	err := v.Verify(slotLaggingContext{context.Background(), time.Now().Add(-time.Hour)})
	verificationCode(t, err, "deadline", false)
	if called || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expired lagging context reached IO")
	}

	for _, where := range []string{"read", "close"} {
		_, v := verificationFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		if where == "read" {
			v.read = func(int, []byte) (int, error) { cancel(); return 0, unix.EIO }
		} else {
			v.closeFile = func(f *os.File) error {
				err := f.Close()
				if err != nil {
					t.Fatal(err)
				}
				cancel()
				return unix.EIO
			}
		}
		err := v.Verify(ctx)
		cancel()
		verificationCode(t, err, "changed", true)
		if !errors.Is(err, unix.EIO) || !errors.Is(err, context.Canceled) {
			t.Fatal("native or cancellation cause lost")
		}
	}
}

func TestSlotVerifierRejectsInvalidBindingsWithoutReading(t *testing.T) {
	f, v := verificationFixture(t)
	for _, data := range [][]byte{nil, []byte("{}"), []byte(strings.Repeat("x", 8193)), append(append([]byte(nil), v.expected...), ' ')} {
		_, err := NewVerifier(f.fd, v.identity, data, v.until)
		verificationCode(t, err, "invalid", false)
	}
	var nilVerifier *Verifier
	verificationCode(t, nilVerifier.Verify(context.Background()), "internal", true)
	verificationCode(t, v.Verify(nil), "internal", true)
	if err := f.fd.Close(); err != nil {
		t.Fatal(err)
	}
	verificationCode(t, v.Verify(context.Background()), "directory", true)
}

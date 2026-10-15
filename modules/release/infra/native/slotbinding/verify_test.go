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

// These checks observe one borrowed open-file description, including its
// directory cursor. The independent open is only a flock exclusion probe.
func borrowedSlotWitness(t *testing.T, f fixtureDir) func() {
	t.Helper()
	fd := int(f.fd.Fd())
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	var entries [4096]byte
	if n, err := unix.ReadDirent(fd, entries[:]); err != nil || n == 0 {
		t.Fatalf("advance borrowed directory cursor: %d %v", n, err)
	}
	offset, err := unix.Seek(fd, 0, 1)
	if err != nil || offset == 0 {
		t.Fatalf("nonzero directory cursor: %d %v", offset, err)
	}
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		t.Fatal(err)
	}
	inheritance, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
	if err != nil {
		t.Fatal(err)
	}
	other, err := os.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = other.Close() })
	return func() {
		t.Helper()
		if got, err := unix.Seek(fd, 0, 1); err != nil || got != offset {
			t.Fatalf("borrowed directory cursor changed: %d %v, want %d", got, err, offset)
		}
		if got, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0); err != nil || got != flags {
			t.Fatalf("borrowed status flags changed: %d %v, want %d", got, err, flags)
		}
		if got, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0); err != nil || got != inheritance {
			t.Fatalf("borrowed inheritance changed: %d %v, want %d", got, err, inheritance)
		}
		if err := unix.Flock(int(other.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK && err != unix.EAGAIN {
			t.Fatalf("borrowed flock lost: %v", err)
		}
	}
}

func TestSlotBorrowedDirectoryCursorAcrossSuccessAndRefusal(t *testing.T) {
	f, v := verificationFixture(t)
	check := borrowedSlotWitness(t, f)
	for range 2 {
		if err := v.Verify(context.Background()); err != nil {
			t.Fatal(err)
		}
		check()
	}
	if err := os.WriteFile(f.file(), []byte(strings.Replace(string(v.expected), "shared", "legacy", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	verificationCode(t, v.Verify(context.Background()), "mismatch", false)
	check()
}

func awaitSlotWitness(t *testing.T, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native seam did not enter")
	}
}

func slotStillActive(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		t.Fatalf("returned before native/cleanup release: %v", err)
	default:
	}
}

func slotResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("native/cleanup release did not return")
		return nil
	}
}

func TestSlotExpiryDuringNativeReadAndCleanupReturn(t *testing.T) {
	for _, bound := range []string{"verifier", "earlier-lagging-context"} {
		for _, where := range []string{"read", "close"} {
			for _, nativeError := range []bool{false, true} {
				t.Run(bound+"/"+where+"/error="+strconv.FormatBool(nativeError), func(t *testing.T) {
					f, v := verificationFixture(t)
					check := borrowedSlotWitness(t, f)
					entered, release := make(chan struct{}), make(chan struct{})
					deadline := time.Now().Add(time.Second)
					ctx := context.Context(slotLaggingContext{context.Background(), deadline.Add(time.Minute)})
					if bound == "verifier" {
						v.until = deadline
					} else {
						ctx = slotLaggingContext{context.Background(), deadline}
					}
					entryOnTime := make(chan bool, 1)
					block := func() error {
						entryOnTime <- time.Now().Before(deadline)
						close(entered)
						<-release
						if nativeError {
							return unix.EIO
						}
						return nil
					}
					reads, closes, ownedFD := 0, 0, -1
					v.read = func(fd int, data []byte) (int, error) {
						reads++
						ownedFD = fd
						if where == "read" {
							if err := block(); err != nil {
								return 0, err
							}
						}
						return unix.Read(fd, data)
					}
					v.closeFile = func(file *os.File) error {
						closes++
						var seamError error
						if where == "close" {
							seamError = block()
						}
						return errors.Join(file.Close(), seamError)
					}
					result, done := make(chan error, 1), make(chan struct{})
					go func() { defer close(done); result <- v.Verify(ctx) }()
					defer func() {
						select {
						case <-release:
						default:
							close(release)
						}
						awaitSlotWitness(t, done)
					}()
					awaitSlotWitness(t, entered)
					if !<-entryOnTime {
						t.Fatal("seam missed original absolute bound")
					}
					<-time.After(time.Until(deadline))
					slotStillActive(t, result)
					check()
					close(release)
					err := slotResult(t, result)
					code := "deadline"
					if nativeError {
						code = "changed"
					}
					verificationCode(t, err, code, nativeError)
					if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, unix.EIO) != nativeError {
						t.Fatalf("deadline/native causes lost: %v", err)
					}
					if reads < 1 || closes != 1 || ownedFD < 0 {
						t.Fatalf("read/cleanup counts: %d %d fd=%d", reads, closes, ownedFD)
					}
					if _, err := unix.FcntlInt(uintptr(ownedFD), unix.F_GETFD, 0); err != unix.EBADF {
						t.Fatalf("owned read descriptor survived return: %v", err)
					}
					check()
					if bound == "verifier" {
						called := false
						v.step = func(string) { called = true }
						verificationCode(t, v.Verify(slotLaggingContext{context.Background(), deadline.Add(time.Hour)}), "deadline", false)
						if called {
							t.Fatal("later observation renewed original verifier budget")
						}
						check()
					}
				})
			}
		}
	}
}

func TestSlotCallerRetainsBorrowedCustodyThroughNativeAndCleanupReturn(t *testing.T) {
	for _, where := range []string{"read", "close"} {
		t.Run(where, func(t *testing.T) {
			f, v := verificationFixture(t)
			check := borrowedSlotWitness(t, f)
			entered, release := make(chan struct{}), make(chan struct{})
			block := func() { close(entered); <-release }
			first := true
			v.read = func(fd int, data []byte) (int, error) {
				if where == "read" && first {
					first = false
					block()
				}
				return unix.Read(fd, data)
			}
			v.closeFile = func(file *os.File) error {
				if where == "close" {
					block()
				}
				return file.Close()
			}
			result, done := make(chan error, 1), make(chan struct{})
			go func() { defer close(done); result <- v.Verify(context.Background()) }()
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
				awaitSlotWitness(t, done)
			}()
			awaitSlotWitness(t, entered)
			// The caller is obligated to hold this borrowed File through actual
			// return. os.File.Close is not an owner-scope synchronization API.
			slotStillActive(t, result)
			check()
			close(release)
			if err := slotResult(t, result); err != nil {
				t.Fatal(err)
			}
			check()
			if err := f.fd.Close(); err != nil {
				t.Fatal(err)
			}
			other, err := os.Open(f.dir)
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			if err := unix.Flock(int(other.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
				t.Fatalf("caller-owned close did not release flock after actual return: %v", err)
			}
		})
	}
}

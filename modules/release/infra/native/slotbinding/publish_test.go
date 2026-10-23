package slotbinding

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	"golang.org/x/sys/unix"
)

type fixtureDir struct {
	p    *Publisher
	dir  string
	fd   *os.File
	data []byte
}

func setup(t *testing.T) fixtureDir {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	fd, err := os.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fd.Close() })
	p, err := New(fd)
	if err != nil {
		t.Fatal(err)
	}
	return fixtureDir{p, dir, fd, fixture(`"0.2.4"`)}
}
func decision(t *testing.T, f fixtureDir, ctx context.Context, want port.SlotBindingDecision) port.SlotBindingResult {
	t.Helper()
	r, err := f.p.Publish(ctx, f.data)
	if err != nil || r.Decision != want {
		t.Fatalf("got %+v, %v want %v", r, err, want)
	}
	return r
}
func (tst fixtureDir) file() string { return filepath.Join(tst.dir, filename) }
func TestPublicationIdempotentAndBorrowed(t *testing.T) {
	f := setup(t)
	decision(t, f, context.Background(), port.SlotBindingConfirmed)
	before, err := os.Stat(f.file())
	if err != nil {
		t.Fatal(err)
	}
	if before.Mode().Perm() != 0o600 {
		t.Fatal(before.Mode())
	}
	decision(t, f, context.Background(), port.SlotBindingConfirmed)
	after, err := os.Stat(f.file())
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("rewritten", err)
	}
	got, err := os.ReadFile(f.file())
	if err != nil || !bytes.Equal(got, f.data) {
		t.Fatal("bytes", err)
	}
	if _, err := f.fd.Stat(); err != nil {
		t.Fatal("closed borrowed directory", err)
	}
	names, err := os.ReadDir(f.dir)
	if err != nil || len(names) != 1 || names[0].Name() != filename {
		t.Fatal(names, err)
	}
	changed := f
	changed.data = bytes.Replace(f.data, []byte("shared"), []byte("legacy"), 1)
	r := decision(t, changed, context.Background(), port.SlotBindingRefused)
	if r.Code != "slot_binding_mismatch" {
		t.Fatal(r)
	}
	got, _ = os.ReadFile(f.file())
	if !bytes.Equal(got, f.data) {
		t.Fatal("overwritten")
	}
}
func TestPublicationUsesRenamedDescriptor(t *testing.T) {
	f := setup(t)
	moved := f.dir + "-held"
	if err := os.Rename(f.dir, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(moved) })
	if err := os.Mkdir(f.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	decision(t, f, context.Background(), port.SlotBindingConfirmed)
	if _, err := os.Lstat(f.file()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("redirected", err)
	}
	got, err := os.ReadFile(filepath.Join(moved, filename))
	if err != nil || !bytes.Equal(got, f.data) {
		t.Fatal(err)
	}
}
func TestRefusalsLeaveExistingBytes(t *testing.T) {
	for _, kind := range []string{"nonempty", "symlink", "hardlink", "mode", "directory", "fifo", "oversized", "different", "empty", "owner"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			switch kind {
			case "nonempty":
				os.WriteFile(filepath.Join(f.dir, "journal.json"), []byte("authoritative"), 0o600)
			case "symlink":
				os.Symlink("elsewhere", f.file())
			case "directory":
				os.Mkdir(f.file(), 0o700)
			case "fifo":
				if err := unix.Mkfifo(f.file(), 0o600); err != nil {
					t.Fatal(err)
				}
			default:
				data := f.data
				if kind == "oversized" {
					data = bytes.Repeat([]byte("x"), 8193)
				}
				if kind == "different" {
					data = fixture(`"older"`)
				}
				if kind == "empty" {
					data = nil
				}
				if err := os.WriteFile(f.file(), data, 0o600); err != nil {
					t.Fatal(err)
				}
				if kind == "mode" {
					os.Chmod(f.file(), 0o644)
				}
				if kind == "hardlink" {
					if err := os.Link(f.file(), filepath.Join(f.dir, "second")); err != nil {
						t.Fatal(err)
					}
				}
				if kind == "owner" {
					if os.Geteuid() != 0 {
						t.Skip("requires disposable chown authority")
					}
					if err := os.Chown(f.file(), 1, 1); err != nil {
						t.Fatal(err)
					}
				}
			}
			before, err := os.Lstat(f.file())
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				t.Fatal(err)
			}
			decision(t, f, context.Background(), port.SlotBindingRefused)
			after, _ := os.Lstat(f.file())
			if before != nil && (after == nil || !os.SameFile(before, after)) {
				t.Fatal("existing record replaced")
			}
		})
	}
}
func TestDirectoryAndInputRefusal(t *testing.T) {
	if _, err := New(nil); err == nil {
		t.Fatal("nil directory")
	}
	f := setup(t)
	file, err := os.CreateTemp(t.TempDir(), "file")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := New(file); err == nil {
		t.Fatal("regular directory")
	}
	f.data = []byte("{}")
	decision(t, f, context.Background(), port.SlotBindingRefused)
	f.data = fixture(`"0.2.4"`)
	os.Chmod(f.dir, 0o755)
	decision(t, f, context.Background(), port.SlotBindingRefused)
}

func TestMetadataRejectsDifferentOwner(t *testing.T) {
	// Synthetic owner mismatch covers the predicate without requiring chown.
	// The separate physical chown fixture remains skipped on unprivileged hosts.
	f := setup(t)
	st, err := statFD(int(f.fd.Fd()))
	if err != nil || !st.privateDirectory() {
		t.Fatal(st, err)
	}
	st.uid++
	if st.privateDirectory() {
		t.Fatal("accepted foreign directory owner")
	}
	st = fingerprint{mode: unix.S_IFREG | 0o600, uid: uint32(os.Geteuid()), links: 1, size: 1}
	if !st.privateFile() {
		t.Fatal("invalid regular fixture")
	}
	st.uid++
	if st.privateFile() {
		t.Fatal("accepted foreign file owner")
	}
}
func TestCancellationBoundary(t *testing.T) {
	for _, point := range []string{"before", "create-before", "create-after", "link-after", "ack-before"} {
		t.Run(point, func(t *testing.T) {
			f := setup(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if point == "before" {
				cancel()
			} else {
				f.p.step = func(at string) error {
					if at == point {
						cancel()
					}
					return nil
				}
			}
			want := port.SlotBindingUnknown
			if point == "before" || point == "create-before" {
				want = port.SlotBindingRefused
			}
			decision(t, f, ctx, want)
			if want == port.SlotBindingRefused {
				names, _ := os.ReadDir(f.dir)
				if len(names) != 0 {
					t.Fatal("mutation before cancellation")
				}
			} else {
				got, err := os.ReadFile(f.file())
				if err != nil || !bytes.Equal(got, f.data) {
					t.Fatal("original local drain did not finish", err)
				}
				decision(t, f, context.Background(), port.SlotBindingUnknown)
			}
		})
	}
}
func TestInjectedCheckpoints(t *testing.T) {
	points := []string{"create-before", "create-after", "write-before", "file-sync-before", "file-sync-after", "file-close-after", "link-before", "link-after", "unlink-before", "unlink-after", "directory-sync-before", "directory-sync-after", "readback-before", "ack-before"}
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			f := setup(t)
			f.p.step = func(at string) error {
				if at == point {
					return unix.EIO
				}
				return nil
			}
			want := port.SlotBindingUnknown
			if point == "create-before" {
				want = port.SlotBindingRefused
			}
			decision(t, f, context.Background(), want)
			if _, err := f.fd.Stat(); err != nil {
				t.Fatal("borrowed descriptor closed", err)
			}
			if want == port.SlotBindingUnknown {
				f.p.step = nil
				decision(t, f, context.Background(), port.SlotBindingUnknown)
			}
		})
	}
}
func TestInjectedNativeFailures(t *testing.T) {
	for _, kind := range []string{"create", "write", "zero", "sync-file", "close", "link", "unlink", "sync-dir"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			switch kind {
			case "create":
				f.p.create = func(int, string, int, uint32) (int, error) { return -1, unix.EIO }
			case "write":
				f.p.write = func(int, []byte) (int, error) { return 0, unix.EIO }
			case "zero":
				f.p.write = func(int, []byte) (int, error) { return 0, nil }
			case "sync-file", "sync-dir":
				f.p.syncFile = func(fd int) error {
					if (kind == "sync-dir") == (fd == int(f.fd.Fd())) {
						return unix.EIO
					}
					return unix.Fsync(fd)
				}
			case "close":
				f.p.closeFile = func(fd int) error { unix.Close(fd); return unix.EIO }
			case "link":
				f.p.link = func(int, string, int, string, int) error { return unix.EIO }
			case "unlink":
				f.p.unlink = func(int, string, int) error { return unix.EIO }
			}
			decision(t, f, context.Background(), port.SlotBindingUnknown)
		})
	}
}
func TestShortWritesAndCompetingPublication(t *testing.T) {
	for _, kind := range []string{"short", "matching", "mismatch", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			if kind == "short" {
				f.p.write = func(fd int, b []byte) (int, error) { return unix.Write(fd, b[:min(7, len(b))]) }
			} else {
				f.p.link = func(parent int, temp string, target int, name string, flags int) error {
					data := f.data
					if kind == "mismatch" {
						data = fixture(`"other"`)
					}
					if kind == "malformed" {
						data = []byte("{}")
					}
					if err := os.WriteFile(f.file(), data, 0o600); err != nil {
						return err
					}
					return unix.EEXIST
				}
			}
			want := port.SlotBindingConfirmed
			if kind == "mismatch" || kind == "malformed" {
				want = port.SlotBindingUnknown
			}
			decision(t, f, context.Background(), want)
			names, _ := os.ReadDir(f.dir)
			if len(names) != 1 || names[0].Name() != filename {
				t.Fatal("owned temp not removed", names)
			}
		})
	}
}
func TestReadFingerprintRaces(t *testing.T) {
	for _, point := range []string{"read-open", "read-bytes"} {
		t.Run(point, func(t *testing.T) {
			f := setup(t)
			decision(t, f, context.Background(), port.SlotBindingConfirmed)
			f.p.step = func(at string) error {
				if at == point {
					f.p.step = nil
					if err := os.Rename(f.file(), f.file()+"-old"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(f.file(), f.data, 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			}
			r := decision(t, f, context.Background(), port.SlotBindingRefused)
			if r.Code != "slot_binding_changed" {
				t.Fatal(r)
			}
		})
	}
}
func TestForeignTempNeverRemoved(t *testing.T) {
	f := setup(t)
	f.p.step = func(at string) error {
		if at == "link-after" {
			names, err := os.ReadDir(f.dir)
			if err != nil {
				t.Fatal(err)
			}
			for _, n := range names {
				if n.Name() != filename {
					path := filepath.Join(f.dir, n.Name())
					if err := os.Rename(path, path+"-held"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte("foreign"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
		return nil
	}
	decision(t, f, context.Background(), port.SlotBindingUnknown)
	names, _ := os.ReadDir(f.dir)
	found := false
	for _, n := range names {
		data, _ := os.ReadFile(filepath.Join(f.dir, n.Name()))
		if string(data) == "foreign" {
			found = true
		}
	}
	if !found {
		t.Fatal("foreign temp removed")
	}
}

func TestConcurrentMatchingPublications(t *testing.T) {
	f := setup(t)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			r, err := f.p.Publish(context.Background(), f.data)
			if err != nil || r.Decision != port.SlotBindingConfirmed {
				t.Errorf("publication: %+v %v", r, err)
			}
		})
	}
	wg.Wait()
	names, err := os.ReadDir(f.dir)
	if err != nil || len(names) != 1 || names[0].Name() != filename {
		t.Fatal(names, err)
	}
}

func TestNewEntryDuringPreparationIsPreserved(t *testing.T) {
	f := setup(t)
	foreign := filepath.Join(f.dir, "journal.json")
	f.p.step = func(point string) error {
		if point == "file-close-after" {
			return os.WriteFile(foreign, []byte("authoritative"), 0o600)
		}
		return nil
	}
	decision(t, f, context.Background(), port.SlotBindingUnknown)
	if data, err := os.ReadFile(foreign); err != nil || string(data) != "authoritative" {
		t.Fatal("foreign entry changed", err)
	}
	if _, err := os.Lstat(f.file()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("published into nonempty operation", err)
	}
}

func TestReadbackMutationRemainsUnknown(t *testing.T) {
	f := setup(t)
	f.p.step = func(point string) error {
		if point == "readback-before" {
			return os.WriteFile(f.file(), fixture(`"other"`), 0o600)
		}
		return nil
	}
	decision(t, f, context.Background(), port.SlotBindingUnknown)
	if got, err := os.ReadFile(f.file()); err != nil || !bytes.Equal(got, fixture(`"other"`)) {
		t.Fatal("readback repaired foreign bytes", err)
	}
}

func TestReadOpenReplacementCannotFollowOrBlock(t *testing.T) {
	for _, kind := range []string{"symlink", "fifo", "in-place"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			decision(t, f, context.Background(), port.SlotBindingConfirmed)
			f.p.step = func(point string) error {
				if point != "read-open" {
					return nil
				}
				if kind == "in-place" {
					return os.WriteFile(f.file(), fixture(`"other"`), 0o600)
				}
				if err := os.Rename(f.file(), f.file()+"-held"); err != nil {
					return err
				}
				if kind == "symlink" {
					return os.Symlink(f.file()+"-held", f.file())
				}
				return unix.Mkfifo(f.file(), 0o600)
			}
			r := decision(t, f, context.Background(), port.SlotBindingRefused)
			if r.Code != "slot_binding_changed" {
				t.Fatal(r)
			}
		})
	}
}

// The desktop update witness must publish first: its staged directory would
// otherwise deterministically trip the real native publisher's nonempty guard.
func TestFirstPublicationMustPrecedeStaging(t *testing.T) {
	for _, stageFirst := range []bool{true, false} {
		name := "publication-before-stage"
		if stageFirst {
			name = "stage-before-publication"
		}
		t.Run(name, func(t *testing.T) {
			f := setup(t)
			staged := filepath.Join(f.dir, "staged.app")
			if stageFirst {
				if err := os.Mkdir(staged, 0o700); err != nil {
					t.Fatal(err)
				}
				decision(t, f, context.Background(), port.SlotBindingRefused)
				if _, err := os.Lstat(f.file()); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("published into populated operation", err)
				}
				if _, err := os.Stat(staged); err != nil {
					t.Fatal("removed refused caller staging", err)
				}
				return
			}
			decision(t, f, context.Background(), port.SlotBindingConfirmed)
			if err := os.Mkdir(staged, 0o700); err != nil {
				t.Fatal(err)
			}
			if got, err := os.ReadFile(f.file()); err != nil || !bytes.Equal(got, f.data) {
				t.Fatal("staging changed binding", err)
			}
			// A previously confirmed identical binding stays valid after later staging.
			decision(t, f, context.Background(), port.SlotBindingConfirmed)
		})
	}
}

package journal

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"golang.org/x/sys/unix"
)

func TestNativeReadRejectsUnsafeRecords(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "directory", "fifo", "mode", "setuid", "oversized", "corrupt", "crossed", "unicode"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			name := filepath.Join(f.path, filename)
			switch kind {
			case "symlink":
				if err := os.WriteFile(filepath.Join(f.path, "other"), f.encoded(t, "prepared"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("other", name); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				f.put(t, "prepared")
				if err := os.Link(name, filepath.Join(f.path, "alias")); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(name, 0o700); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := unix.Mkfifo(name, 0o600); err != nil {
					t.Fatal(err)
				}
			case "mode":
				f.put(t, "prepared")
				if err := os.Chmod(name, 0o640); err != nil {
					t.Fatal(err)
				}
			case "setuid":
				f.put(t, "prepared")
				if err := os.Chmod(name, 0o600|os.ModeSetuid); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				if err := os.WriteFile(name, bytes.Repeat([]byte(" "), records.MaxRecordBytes+1), 0o600); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				if err := os.WriteFile(name, []byte("private invalid fixture"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "crossed":
				data := bytes.ReplaceAll(f.encoded(t, "prepared"), []byte(f.operation.Target.Digest), []byte(strings.Repeat("f", 64)))
				if err := os.WriteFile(name, data, 0o600); err != nil {
					t.Fatal(err)
				}
			case "unicode":
				if err := os.WriteFile(name, []byte("{\"schema\":\"\\ud800\"}"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			view, err := r.Read(context.Background())
			if view != nil || err == nil {
				t.Fatalf("unsafe %s admitted", kind)
			}
			if strings.Contains(err.Error(), f.path) || strings.Contains(err.Error(), "private invalid") {
				t.Fatal("private bytes leaked")
			}
			if kind == "crossed" && !errors.Is(err, records.BindingMismatch) {
				t.Fatal(err)
			}
		})
	}
}

func TestNativeReadBoundsAndSnapshotRaces(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	data := f.encoded(t, "prepared")
	data = append(data, bytes.Repeat([]byte(" "), records.MaxRecordBytes-len(data))...)
	if err := os.WriteFile(filepath.Join(f.path, filename), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, r).Value == nil {
		t.Fatal("exact bound refused")
	}
	for _, kind := range []string{"replace-before-open", "fifo-before-open", "symlink-before-open", "replace-after-read", "in-place", "grow", "hardlink", "disappear"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			f.put(t, "prepared")
			name := filepath.Join(f.path, filename)
			r.step = func(at string) error {
				point := "read-bytes"
				if strings.HasSuffix(kind, "before-open") {
					point = "read-open"
				}
				if at != point {
					return nil
				}
				switch kind {
				case "replace-before-open", "replace-after-read":
					if err := os.Rename(name, name+".old"); err != nil {
						t.Fatal(err)
					}
					f.put(t, "prepared")
				case "fifo-before-open":
					if err := os.Remove(name); err != nil {
						t.Fatal(err)
					}
					if err := unix.Mkfifo(name, 0o600); err != nil {
						t.Fatal(err)
					}
				case "symlink-before-open":
					if err := os.Rename(name, name+".old"); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(filename+".old", name); err != nil {
						t.Fatal(err)
					}
				case "in-place":
					f.put(t, "verified")
				case "grow":
					fd, err := os.OpenFile(name, os.O_APPEND|os.O_WRONLY, 0)
					if err != nil {
						t.Fatal(err)
					}
					if _, err := fd.Write([]byte(" ")); err != nil {
						t.Fatal(err)
					}
					fd.Close()
				case "hardlink":
					if err := os.Link(name, name+".alias"); err != nil {
						t.Fatal(err)
					}
				case "disappear":
					if err := os.Remove(name); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			}
			view, err := r.Read(context.Background())
			if view != nil {
				t.Fatal("changing read admitted")
			}
			requireError(t, err, port.JournalChanged)
		})
	}
}

func TestAbsenceAndParentReplacementAreNotEmptyState(t *testing.T) {
	for _, kind := range []string{"absence-race", "parent-replace", "parent-mode", "ancestor-symlink"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			switch kind {
			case "absence-race":
				r.step = func(at string) error {
					if at == "read-absence" {
						f.put(t, "prepared")
					}
					return nil
				}
			case "parent-replace":
				if err := os.Rename(f.path, f.path+"-old"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(f.path, 0o700); err != nil {
					t.Fatal(err)
				}
			case "parent-mode":
				if err := os.Chmod(f.path, 0o750); err != nil {
					t.Fatal(err)
				}
			case "ancestor-symlink":
				parent := filepath.Dir(f.path)
				moved := parent + "-moved"
				if err := os.Rename(parent, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, parent); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.Remove(parent); os.Rename(moved, parent) })
			}
			view, err := r.Read(context.Background())
			if view != nil {
				t.Fatal("uncertain root became absence")
			}
			requireError(t, err, port.JournalChanged)
		})
	}
}

func TestNativeOwnerMeasurementAndForeignOwnerLimit(t *testing.T) {
	f := newFixture(t)
	f.put(t, "prepared")
	info, err := os.Lstat(filepath.Join(f.path, filename))
	if err != nil {
		t.Fatal(err)
	}
	actual, ok := metadata(info)
	if !ok || actual.UID != uint64(os.Geteuid()) || !privateFile(info, actual) {
		t.Fatal("actual owned file not qualified")
	}
	synthetic := actual
	synthetic.UID++
	if privateFile(info, synthetic) {
		t.Fatal("predicate-only foreign owner accepted")
	}
	t.Run("actual-foreign-owner", func(t *testing.T) {
		if os.Geteuid() != 0 {
			t.Skip("changing disposable file UID requires root; no escalation or foreign-UID native claim")
		}
		if err := os.Chown(filepath.Join(f.path, filename), 1, -1); err != nil {
			t.Fatal(err)
		}
		r := f.open(t)
		view, err := r.Read(context.Background())
		if view != nil || err == nil {
			t.Fatal("foreign owner accepted")
		}
	})
}

func TestAncestorGenerationCannotBeReboundAroundSameOperation(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	parent := filepath.Dir(f.path)
	moved := parent + "-old"
	if err := os.Rename(parent, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(moved, f.operation.ID), f.path); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		os.Rename(f.path, filepath.Join(moved, f.operation.ID))
		os.Remove(parent)
		os.Rename(moved, parent)
	})
	value, err := r.Read(context.Background())
	if value != nil {
		t.Fatal("same operation inode rebound to a new parent generation")
	}
	requireError(t, err, port.JournalChanged)
}

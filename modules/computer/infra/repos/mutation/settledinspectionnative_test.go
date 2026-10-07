//go:build darwin

package mutation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Authored for Lead's reserved native lane. Disposable roots and synthetic
// canonical receipts only; no owner profile, app, process or provider evidence.
func settledNativeFixture(t *testing.T) (Root, SettledSelection, []ExpectedSettledRecord, []settledBytes) {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(path, "mutations"), 0700); err != nil {
		t.Fatal(err)
	}
	// Fixture authors the EXISTING lock, not InspectSettled.
	if err := os.WriteFile(filepath.Join(path, writerName), nil, 0600); err != nil {
		t.Fatal(err)
	}
	var s unix.Stat_t
	if err := unix.Lstat(path, &s); err != nil {
		t.Fatal(err)
	}
	root := Root{Path: path, Device: uint64(s.Dev), Inode: s.Ino, OwnerUID: s.Uid}
	selection, expected, entries := settledPureFixture(t)
	for _, e := range entries {
		if err := os.WriteFile(filepath.Join(path, "mutations", e.key), e.raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root, selection, expected, entries
}

type settledNativeOriginal struct {
	stat unix.Stat_t
	raw  []byte
	link string
}

func settledNativeSnapshot(t *testing.T, root string) map[string]settledNativeOriginal {
	t.Helper()
	result := make(map[string]settledNativeOriginal)
	err := filepath.WalkDir(root, func(path string, _ fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		var original settledNativeOriginal
		if err := unix.Lstat(path, &original.stat); err != nil {
			return err
		}
		switch uint32(original.stat.Mode) & unix.S_IFMT {
		case unix.S_IFREG:
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			original.raw = raw
		case unix.S_IFLNK:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			original.link = link
		}
		result[path] = original
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func settledNativePreserved(t *testing.T, root string, before map[string]settledNativeOriginal) {
	t.Helper()
	after := settledNativeSnapshot(t, root)
	if len(before) != len(after) {
		t.Fatal("inspection changed namespace")
	}
	for path, original := range before {
		current, ok := after[path]
		if !ok || !stable(original.stat, current.stat) || !bytes.Equal(original.raw, current.raw) || original.link != current.link {
			t.Fatal("inspection changed or replaced an original", filepath.Base(path))
		}
	}
}

func TestSettledInspectionNativeClosedSetAndHeldWriter(t *testing.T) {
	root, selection, expected, _ := settledNativeFixture(t)
	before := settledNativeSnapshot(t, root.Path)
	visits := 0
	out, err := InspectSettled(context.Background(), root, selection, expected, func(meta SettledInspection) error {
		visits++
		if meta.Root != root || meta.MutationsInode == 0 || meta.LockInode == 0 || meta.Retained[0].Key >= meta.Retained[1].Key {
			t.Fatal("invalid observed metadata")
		}
		// A nested ordinary writer and a nested observation must both refuse
		// under the retained same-store flock, with no second writer admitted.
		r, err := New(context.Background(), root)
		if r != nil {
			_ = r.Close()
			t.Fatal("visitor acquired a second writer")
		}
		if err == nil {
			t.Fatal("nested writer did not refuse")
		}
		nested, err := InspectSettled(context.Background(), root, selection, expected, func(SettledInspection) error { t.Fatal("nested visitor called"); return nil })
		if err == nil || nested != nil {
			t.Fatal("nested inspection acquired writer lock")
		}
		return nil
	})
	if err != nil || out == nil || visits != 1 {
		t.Fatal("closed canonical set refused", out, err)
	}
	settledNativePreserved(t, root.Path, before)
	if empty, err := InspectEmpty(context.Background(), root); err == nil || empty != nil {
		t.Fatal("InspectEmpty accepted nonempty journal")
	}
	// Descriptors and flock are released after return; a fresh writer can be
	// constructed on this disposable fixture, without an execution claim.
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal("inspection leaked writer ownership", err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	settledNativePreserved(t, root.Path, before)
}

func TestSettledInspectionNativeRefusalsPreserveOriginals(t *testing.T) {
	for _, name := range []string{"writer-active", "missing-lock", "nonempty-lock", "lock-mode", "lock-symlink", "lock-hardlink", "lock-fifo", "missing-record", "extra-record", "staging", "129-records", "directory", "symlink", "hardlink", "fifo", "record-mode", "oversize", "malformed", "duplicate-identity", "prepared", "failed", "outcome_unknown", "root-mismatch", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, entries := settledNativeFixture(t)
			path := filepath.Join(root.Path, "mutations", entries[0].key)
			lock := filepath.Join(root.Path, writerName)
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch name {
			case "writer-active":
				r, err := New(ctx, root)
				must(err)
				t.Cleanup(func() {
					if err := r.Close(); err != nil {
						t.Error(err)
					}
				})
			case "missing-lock":
				must(os.Remove(lock))
			case "nonempty-lock":
				must(os.WriteFile(lock, []byte("retained-unknown"), 0600))
			case "lock-mode":
				must(os.Chmod(lock, 0644))
			case "lock-symlink":
				moved := filepath.Join(root.Path, "original-lock")
				must(os.Rename(lock, moved))
				must(os.Symlink(moved, lock))
			case "lock-hardlink":
				must(os.Link(lock, filepath.Join(root.Path, "lock-alias")))
			case "lock-fifo":
				must(os.Rename(lock, filepath.Join(root.Path, "original-lock")))
				must(unix.Mkfifo(lock, 0600))
			case "missing-record":
				must(os.Remove(path))
			case "extra-record":
				must(os.WriteFile(filepath.Join(root.Path, "mutations", "unexpected"), []byte("retained"), 0600))
			case "staging":
				must(os.WriteFile(filepath.Join(root.Path, "mutations", ".unknown.tmp"), []byte("retained"), 0600))
			case "129-records":
				for n := 0; n < 127; n++ {
					must(os.WriteFile(filepath.Join(root.Path, "mutations", fmt.Sprintf("%064x.json", n)), []byte("retained"), 0600))
				}
			case "directory":
				must(os.Remove(path))
				must(os.Mkdir(path, 0700))
				must(os.WriteFile(filepath.Join(path, "retained"), []byte("do not sweep"), 0600))
			case "symlink":
				must(os.Remove(path))
				must(os.Symlink(entries[1].key, path))
			case "hardlink":
				must(os.Link(path, filepath.Join(root.Path, "record-alias")))
			case "fifo":
				must(os.Remove(path))
				must(unix.Mkfifo(path, 0600))
			case "record-mode":
				must(os.Chmod(path, 0644))
			case "oversize":
				must(os.WriteFile(path, bytes.Repeat([]byte("x"), maxRecordBytes+1), 0600))
			case "malformed":
				must(os.WriteFile(path, []byte("{"), 0600))
			case "duplicate-identity":
				must(os.WriteFile(path, entries[1].raw, 0600))
			case "prepared", "failed", "outcome_unknown":
				state, err := domain.NewPrepared(expected[0].Binding)
				must(err)
				if name != "prepared" {
					f := domain.Failure{Code: "WORKSPACE_HELPER_FAILED", Source: "native-workspace"}
					if name == "outcome_unknown" {
						f.Code = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
					}
					state, err = state.Refuse(f)
					must(err)
				}
				raw, err := encode(state)
				must(err)
				must(os.WriteFile(path, raw, 0600))
			case "root-mismatch":
				root.Inode++
			case "cancelled":
				cancel()
			}
			before := settledNativeSnapshot(t, root.Path)
			visits := 0
			out, err := InspectSettled(ctx, root, selection, expected, func(SettledInspection) error { visits++; return nil })
			if err == nil || out != nil || visits != 0 {
				t.Fatal("unsafe observation reached callback", out, err, visits)
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

func TestSettledInspectionNativeFreshRecheckAndLateVisitor(t *testing.T) {
	for _, name := range []string{"changed-bytes", "same-bytes-new-inode", "added-staging", "removed-record", "changed-lock", "replaced-lock", "changed-directory-mode", "replaced-directory", "replaced-root", "late-cancel", "callback-error"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, entries := settledNativeFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var before map[string]settledNativeOriginal
			visits := 0
			out, err := InspectSettled(ctx, root, selection, expected, func(SettledInspection) error {
				visits++
				path := filepath.Join(root.Path, "mutations", entries[0].key)
				lock := filepath.Join(root.Path, writerName)
				must := func(err error) {
					t.Helper()
					if err != nil {
						t.Fatal(err)
					}
				}
				switch name {
				case "changed-bytes":
					must(os.WriteFile(path, bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1), 0600))
				case "same-bytes-new-inode":
					must(os.Rename(path, filepath.Join(root.Path, "retained-original")))
					must(os.WriteFile(path, entries[0].raw, 0600))
				case "added-staging":
					must(os.WriteFile(filepath.Join(root.Path, "mutations", ".late.tmp"), []byte("retained"), 0600))
				case "removed-record":
					must(os.Rename(path, filepath.Join(root.Path, "retained-original")))
				case "changed-lock":
					must(os.WriteFile(lock, []byte("retained"), 0600))
				case "replaced-lock":
					must(os.Rename(lock, filepath.Join(root.Path, "retained-lock")))
					must(os.WriteFile(lock, nil, 0600))
				case "changed-directory-mode":
					must(os.Chmod(filepath.Join(root.Path, "mutations"), 0755))
				case "replaced-directory":
					must(os.Rename(filepath.Join(root.Path, "mutations"), filepath.Join(root.Path, "retained-mutations")))
					must(os.Mkdir(filepath.Join(root.Path, "mutations"), 0700))
				case "replaced-root":
					must(os.Rename(root.Path, root.Path+"-retained"))
					t.Cleanup(func() {
						if err := os.RemoveAll(root.Path + "-retained"); err != nil {
							t.Error(err)
						}
					})
					must(os.Mkdir(root.Path, 0700))
				case "late-cancel":
					cancel()
				}
				// Snapshot the TEST'S intentional substitutions. Inspection must
				// neither undo them nor touch any retained evidence afterward.
				before = settledNativeSnapshot(t, root.Path)
				if name == "replaced-root" {
					for path, original := range settledNativeSnapshot(t, root.Path+"-retained") {
						before[path] = original
					}
				}
				if name == "callback-error" {
					return errors.New("private diagnostic")
				}
				return nil
			})
			if err == nil || out != nil || visits != 1 {
				t.Fatal("changed/late visitor accepted or replayed", out, err, visits)
			}
			if name == "replaced-root" {
				current := settledNativeSnapshot(t, root.Path)
				for path, original := range settledNativeSnapshot(t, root.Path+"-retained") {
					current[path] = original
				}
				if len(before) != len(current) {
					t.Fatal("inspection changed retained roots")
				}
				for path, original := range before {
					if now, ok := current[path]; !ok || !stable(original.stat, now.stat) || !bytes.Equal(original.raw, now.raw) {
						t.Fatal("inspection changed retained root evidence")
					}
				}
			} else {
				settledNativePreserved(t, root.Path, before)
			}
		})
	}
}

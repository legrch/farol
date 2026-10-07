//go:build darwin

package mutation

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// AUTHOR NOT RUN: reserved for Lead's exclusive native lane. These tests use
// disposable stores and synthetic receipts, never owner profiles or live effects.
func interruptedChatSettledNativeFixture(t *testing.T) (Root, SettledSelection, []ExpectedSettledRecord, []settledBytes) {
	t.Helper()
	selection, expected, entries := interruptedChatSettledPureFixture(t)
	return settledNativeFixtureForRecords(t, selection, expected, entries)
}

func TestInterruptedChatSettledInspectionNativeExactSetPreservedAndWriterHeld(t *testing.T) {
	root, selection, expected, _ := interruptedChatSettledNativeFixture(t)
	before := settledNativeSnapshot(t, root.Path)
	visits := 0
	out, err := InspectInterruptedChatSettled(context.Background(), root, selection, expected, func(meta InterruptedChatSettledInspection) error {
		visits++
		if meta.Root != root || meta.MutationsInode == 0 || meta.LockInode == 0 || len(meta.Retained) != 5 {
			t.Fatal("invalid observation metadata")
		}
		for n, r := range meta.Retained {
			if n > 0 && meta.Retained[n-1].Key >= r.Key {
				t.Fatal("retained inventory is not sorted and unique")
			}
		}
		r, err := New(context.Background(), root)
		if r != nil {
			_ = r.Close()
			t.Fatal("visitor acquired another writer")
		}
		if err == nil {
			t.Fatal("writer did not refuse")
		}
		if nested, err := InspectInterruptedChatSettled(context.Background(), root, selection, expected, func(InterruptedChatSettledInspection) error { t.Fatal("nested visitor called"); return nil }); err == nil || nested != nil {
			t.Fatal("nested inspection acquired held writer lock")
		}
		meta.Retained[0] = SettledRetainedRecord{}
		return nil
	})
	if err != nil || out == nil || visits != 1 || out.Retained[0].Key == "" {
		t.Fatal("closed canonical set refused", err)
	}
	settledNativePreserved(t, root.Path, before)
	if out, err := InspectSettled(context.Background(), root, selection, expected[:2], func(SettledInspection) error { t.Fatal("old visitor called"); return nil }); err == nil || out != nil {
		t.Fatal("original inspector accepted five-record inventory")
	}
	if empty, err := InspectEmpty(context.Background(), root); err == nil || empty != nil {
		t.Fatal("InspectEmpty accepted five records")
	}
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal("inspection leaked writer lock", err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	settledNativePreserved(t, root.Path, before)
}

func TestInterruptedChatSettledInspectionNativeRefusalsPreserveOriginals(t *testing.T) {
	for _, name := range []string{"writer-held", "missing", "extra", "hardlink", "symlink", "missing-lock", "lock-hardlink"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, entries := interruptedChatSettledNativeFixture(t)
			path := filepath.Join(root.Path, "mutations", entries[4].key)
			lock := filepath.Join(root.Path, writerName)
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "writer-held":
				r, err := New(context.Background(), root)
				must(err)
				t.Cleanup(func() {
					if err := r.Close(); err != nil {
						t.Error(err)
					}
				})
			case "missing":
				must(os.Rename(path, filepath.Join(root.Path, "retained-conflict")))
			case "extra":
				must(os.WriteFile(filepath.Join(root.Path, "mutations", ".retained.tmp"), []byte("retained"), 0600))
			case "hardlink":
				must(os.Link(path, filepath.Join(root.Path, "conflict-alias")))
			case "symlink":
				must(os.Rename(path, filepath.Join(root.Path, "retained-conflict")))
				must(os.Symlink(filepath.Join(root.Path, "retained-conflict"), path))
			case "missing-lock":
				must(os.Rename(lock, filepath.Join(root.Path, "retained-lock")))
			case "lock-hardlink":
				must(os.Link(lock, filepath.Join(root.Path, "lock-alias")))
			}
			before := settledNativeSnapshot(t, root.Path)
			out, err := InspectInterruptedChatSettled(context.Background(), root, selection, expected, func(InterruptedChatSettledInspection) error { t.Fatal("unsafe set reached visitor"); return nil })
			if err == nil || out != nil {
				t.Fatal("unsafe native inventory accepted")
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

func TestInterruptedChatSettledInspectionNativeFreshRecheck(t *testing.T) {
	for _, name := range []string{"changed-completed", "changed-conflict", "same-bytes-new-inode", "extra", "removed", "changed-lock", "late-hardlink", "cancel-visitor", "callback-error"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, entries := interruptedChatSettledNativeFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var before map[string]settledNativeOriginal
			visits := 0
			out, err := InspectInterruptedChatSettled(ctx, root, selection, expected, func(InterruptedChatSettledInspection) error {
				visits++
				path := filepath.Join(root.Path, "mutations", entries[4].key)
				must := func(err error) {
					t.Helper()
					if err != nil {
						t.Fatal(err)
					}
				}
				switch name {
				case "changed-completed":
					must(os.WriteFile(filepath.Join(root.Path, "mutations", entries[0].key), bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1), 0600))
				case "changed-conflict":
					must(os.WriteFile(path, bytes.Replace(entries[4].raw, []byte("WORKSPACE_MUTATION_CONFLICT"), []byte("WORKSPACE_HELPER_FAILED"), 1), 0600))
				case "same-bytes-new-inode":
					must(os.Rename(path, filepath.Join(root.Path, "retained-conflict")))
					must(os.WriteFile(path, entries[4].raw, 0600))
				case "extra":
					must(os.WriteFile(filepath.Join(root.Path, "mutations", ".late.tmp"), []byte("retained"), 0600))
				case "removed":
					must(os.Rename(path, filepath.Join(root.Path, "retained-conflict")))
				case "changed-lock":
					must(os.WriteFile(filepath.Join(root.Path, writerName), []byte("retained"), 0600))
				case "late-hardlink":
					must(os.Link(path, filepath.Join(root.Path, "conflict-alias")))
				case "cancel-visitor":
					cancel()
				}
				before = settledNativeSnapshot(t, root.Path)
				if name == "callback-error" {
					return errors.New("private diagnostic")
				}
				return nil
			})
			if err == nil || out != nil || visits != 1 {
				t.Fatal("changed observation accepted or visitor replayed", err)
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

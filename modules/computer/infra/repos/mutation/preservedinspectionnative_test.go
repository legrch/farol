//go:build darwin

package mutation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Disposable native storage with synthetic canonical bytes only. No installed
// profile, daemon, process execution, provider, terminal or cleanup claim.
func preservedNativeFixture(t *testing.T) (Root, SettledSelection, []ExpectedPreservedRecord, []settledBytes) {
	t.Helper()
	selection, expected, entries := preservedPureFixture(t)
	// Mirror the selected inventory's two READ-ONLY process reservations.
	_, _, scope, intent := processFixture()
	intent.OperationID = "second-read-op"
	scope.CallID = "second-read-call"
	raw, err := encodeProcess(scope, intent)
	if err != nil {
		t.Fatal(err)
	}
	identity := processIdentity(scope, intent.OperationID)
	key, err := recordKey(identity)
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, settledBytes{key: key, raw: raw})
	expected = append(expected, ExpectedPreservedRecord{Key: key, SHA256: preservedDigest(raw), Identity: identity})
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	return root, selection, expected, entries
}

func TestPreservedInspectionNativeClosedSetAndHeldWriter(t *testing.T) {
	root, selection, expected, _ := preservedNativeFixture(t)
	before := settledNativeSnapshot(t, root.Path)
	visits := 0
	out, err := InspectPreserved(context.Background(), root, selection, expected, func(meta PreservedInspection) error {
		visits++
		if meta.Root != root || meta.MutationsInode == 0 || meta.LockInode == 0 || meta.Retained[0].Key >= meta.Retained[1].Key || len(meta.Retained) != 5 || meta.ReservedProcesses != 2 {
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
		nested, err := InspectPreserved(context.Background(), root, selection, expected, func(PreservedInspection) error { t.Fatal("nested visitor called"); return nil })
		if err == nil || nested != nil {
			t.Fatal("nested inspection acquired writer lock")
		}
		// Visitor replacement of slice elements cannot alter returned metadata.
		meta.Retained[0] = SettledRetainedRecord{}
		return nil
	})
	if err != nil || out == nil || visits != 1 || out.Retained[0].Key == "" || out.ReservedProcesses != 2 {
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

func TestPreservedInspectionNativeRefusalsPreserveOriginals(t *testing.T) {
	for _, name := range []string{"writer-active", "missing-lock", "nonempty-lock", "lock-mode", "lock-symlink", "lock-hardlink", "lock-fifo", "missing-record", "extra-record", "staging", "129-records", "directory", "symlink", "hardlink", "fifo", "record-mode", "root-mode", "directory-mode", "owner-uid", "process-write", "v5", "oversize", "malformed", "duplicate-identity", "prepared", "changed-to-failed", "outcome_unknown", "root-mismatch", "cancelled"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, entries := preservedNativeFixture(t)
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
				for n := 0; n < 124; n++ {
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
			case "root-mode":
				must(os.Chmod(root.Path, 0755))
			case "directory-mode":
				must(os.Chmod(filepath.Join(root.Path, "mutations"), 0755))
			case "owner-uid":
				root.OwnerUID++
			case "process-write":
				_, _, scope, intent := processFixture()
				intent.Seal.Write = true
				raw, err := encodeProcess(scope, intent)
				must(err)
				must(os.WriteFile(filepath.Join(root.Path, "mutations", entries[3].key), raw, 0600))
				expected[3].SHA256 = preservedDigest(raw)
			case "v5":
				raw, _, err := encodeProcessTerminal(terminalValue(nil, nil))
				must(err)
				must(os.WriteFile(filepath.Join(root.Path, "mutations", entries[3].key), raw, 0600))
				expected[3].SHA256 = preservedDigest(raw)
			case "oversize":
				must(os.WriteFile(path, bytes.Repeat([]byte("x"), maxRecordBytes+1), 0600))
			case "malformed":
				must(os.WriteFile(path, []byte("{"), 0600))
			case "duplicate-identity":
				must(os.WriteFile(path, entries[1].raw, 0600))
			case "prepared", "changed-to-failed", "outcome_unknown":
				original, err := decode(entries[0].raw)
				must(err)
				state, err := domain.NewPrepared(original.Binding())
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
			out, err := InspectPreserved(ctx, root, selection, expected, func(PreservedInspection) error { visits++; return nil })
			if err == nil || out != nil || visits != 0 {
				t.Fatal("unsafe observation reached callback", out, err, visits)
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

func TestPreservedInspectionNativeFreshRecheckAndLateVisitor(t *testing.T) {
	for _, name := range []string{"changed-bytes", "same-bytes-new-inode", "added-staging", "removed-record", "changed-lock", "replaced-lock", "changed-directory-mode", "replaced-directory", "replaced-root", "late-cancel", "callback-error", "callback-error-with-change", "cancel-with-change", "late-process-write", "late-hardlink", "late-record-mode"} {
		t.Run(name, func(t *testing.T) {
			root, selection, expected, entries := preservedNativeFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var before map[string]settledNativeOriginal
			visits := 0
			out, err := InspectPreserved(ctx, root, selection, expected, func(PreservedInspection) error {
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
				case "callback-error-with-change", "cancel-with-change":
					must(os.WriteFile(path, []byte("retained changed evidence"), 0600))
					if name == "cancel-with-change" {
						cancel()
					}
				case "late-process-write":
					_, _, scope, intent := processFixture()
					intent.Seal.Write = true
					raw, err := encodeProcess(scope, intent)
					must(err)
					must(os.WriteFile(filepath.Join(root.Path, "mutations", entries[3].key), raw, 0600))
				case "late-hardlink":
					must(os.Link(path, filepath.Join(root.Path, "record-alias")))
				case "late-record-mode":
					must(os.Chmod(path, 0644))
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
				if name == "callback-error" || name == "callback-error-with-change" {
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

// Exercise the native inventory/EOF/pin bound, not just the pure cardinality check.
func TestPreservedInspectionNativeCardinalityBounds(t *testing.T) {
	for _, count := range []int{1, 128} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			selection, _, _ := preservedPureFixture(t)
			_, _, scope, intent := processFixture()
			var expected []ExpectedPreservedRecord
			var entries []settledBytes
			for n := 0; n < count; n++ {
				intent.OperationID = fmt.Sprintf("read-op-%d", n)
				raw, err := encodeProcess(scope, intent)
				if err != nil {
					t.Fatal(err)
				}
				identity := processIdentity(scope, intent.OperationID)
				key, err := recordKey(identity)
				if err != nil {
					t.Fatal(err)
				}
				expected = append(expected, ExpectedPreservedRecord{Key: key, SHA256: preservedDigest(raw), Identity: identity})
				entries = append(entries, settledBytes{key: key, raw: raw})
			}
			root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
			before := settledNativeSnapshot(t, root.Path)
			visits := 0
			out, err := InspectPreserved(context.Background(), root, selection, expected, func(meta PreservedInspection) error {
				visits++
				if len(meta.Retained) != count || meta.ReservedProcesses != count {
					t.Fatal("native inventory lost reservations")
				}
				return nil
			})
			if err != nil || out == nil || visits != 1 || len(out.Retained) != count || out.ReservedProcesses != count {
				t.Fatal("native bound refused", err)
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

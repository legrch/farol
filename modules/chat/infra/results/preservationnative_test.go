//go:build darwin || linux

package results

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

var preservationNative = flag.Bool("chat-preservation-native", false, "run retained disposable result preservation-claim checks")

// Actual private disposable files and flock; synthetic canonical records only.
// No publication ACK, application/provider/process or writable recovery witness.
func preservationNativeFixture(t *testing.T, committed, unknown bool) (Root, port.JournalScope, string, []byte) {
	t.Helper()
	root, scope := closedInspectionNativeFixture(t)
	var storage unix.Stat_t
	child := filepath.Join(root.Path, resultChild)
	if err := unix.Lstat(child, &storage); err != nil {
		t.Fatal(err)
	}
	q := requestFixture()
	raw, err := encodeResult(resultRecord{Version: 1, Root: root.Identity, StorageRoot: port.JournalRoot{Device: uint64(storage.Dev), Inode: uint64(storage.Ino), OwnerUID: storage.Uid}, Request: q})
	if err != nil {
		t.Fatal(err)
	}
	key := resultKey(q)
	write := func(name string, raw []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(child, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(key+".attempt", raw)
	if committed {
		sum := sha256.Sum256(raw)
		write(key+".commit", []byte(hex.EncodeToString(sum[:])))
	}
	if unknown {
		write(resultUnknown, []byte("UNKNOWN"))
	}
	return root, scope, key, raw
}

type preservationInventoryEntry struct {
	meta unix.Stat_t
	raw  string
}

func preservationInventory(t *testing.T, root Root) map[string]preservationInventoryEntry {
	t.Helper()
	files := make(map[string]preservationInventoryEntry)
	err := filepath.WalkDir(root.Path, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		var stat unix.Stat_t
		if err := unix.Lstat(path, &stat); err != nil {
			return err
		}
		var raw []byte
		if !entry.IsDir() {
			raw, err = os.ReadFile(path)
			if err != nil {
				return err
			}
		}
		files[path] = preservationInventoryEntry{meta: stat, raw: string(raw)}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func assertPreservationInventory(t *testing.T, before, after map[string]preservationInventoryEntry) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatal("inspection changed inventory")
	}
	for name, expected := range before {
		actual, found := after[name]
		if !found || expected.raw != actual.raw || !resultStable(expected.meta, actual.meta) {
			t.Fatal("inspection changed original bytes/metadata", name)
		}
	}
}

func TestPreservationNativeRetainsCompletePairsOrUnresolvedCanonicalAttempts(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, state := range []struct{ committed, unknown bool }{{true, false}, {true, true}, {false, false}, {false, true}} {
		t.Run(map[bool]string{true: "committed", false: "attempt"}[state.committed]+map[bool]string{true: "-unknown", false: "-clear"}[state.unknown], func(t *testing.T) {
			root, scope, _, _ := preservationNativeFixture(t, state.committed, state.unknown)
			before := preservationInventory(t, root)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			l, err := AcquirePreservationInspection(ctx, root, scope, TextLimits())
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			v, err := l.Observation()
			if err != nil || v.Root != root.Identity || v.Scope != scope || v.ResultCount != 1 || v.PayloadBytes != len(requestFixture().Payload) || v.Unresolved != (state.unknown || !state.committed) || v.ClaimDigest == ([32]byte{}) || v.SnapshotDigest == ([32]byte{}) {
				t.Fatal("incorrect preservation metadata", v, err)
			}
			v.ResultCount = 999
			if again, err := l.Observation(); err != nil || again.ResultCount != 1 {
				t.Fatal("metadata aliases retained value", err)
			}
			if other, err := openArchiveDisk(ctx, root); err == nil {
				other.d.close()
				t.Fatal("original result claim released")
			}
			if err := l.Verify(); err != nil {
				t.Fatal(err)
			}
			if err := l.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("closed lease yielded metadata")
			}
			if old, err := AcquireClosedInspection(ctx, root, scope); old != nil || err == nil {
				if old != nil {
					old.Close()
				}
				t.Fatal("preservation relaxed empty-only result gate")
			}
			assertPreservationInventory(t, before, preservationInventory(t, root))
		})
	}
}

func TestPreservationNativeRejectsCorruptIncompleteOrForeignDataWithoutRepair(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, kind := range []string{"bad-commit", "bad-record", "commit-only", "unrecognized", "hardlink", "symlink", "world-readable", "profile", "capacity", "partial-marker"} {
		t.Run(kind, func(t *testing.T) {
			root, scope, key, raw := preservationNativeFixture(t, true, false)
			child := filepath.Join(root.Path, resultChild)
			attempt := filepath.Join(child, key+".attempt")
			limits := TextLimits()
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "bad-commit":
				must(os.WriteFile(filepath.Join(child, key+".commit"), []byte("bad"), 0600))
			case "bad-record":
				must(os.WriteFile(attempt, append(raw, ' '), 0600))
			case "commit-only":
				must(os.Rename(attempt, filepath.Join(root.Path, "retained-attempt")))
			case "unrecognized":
				must(os.WriteFile(filepath.Join(child, "extra"), []byte("retained"), 0600))
			case "hardlink":
				must(os.Link(attempt, filepath.Join(root.Path, "retained-link")))
			case "symlink":
				retained := filepath.Join(root.Path, "retained-attempt")
				must(os.Rename(attempt, retained))
				must(os.Symlink(retained, attempt))
			case "world-readable":
				must(os.Chmod(attempt, 0644))
			case "profile":
				root.ProfileID, scope.ProfileID = "other", "other"
			case "capacity":
				limits.ResultBytes, limits.TotalBytes = 1, 1
			case "partial-marker":
				must(os.WriteFile(filepath.Join(child, resultUnknown), nil, 0600))
			}
			before := preservationInventory(t, root)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			l, err := AcquirePreservationInspection(ctx, root, scope, limits)
			if kind == "partial-marker" {
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				v, err := l.Observation()
				if err != nil || !v.Unresolved || l.Verify() != nil {
					t.Fatal("partial fence lost", err)
				}
				must(l.Close())
			} else if l != nil || err == nil {
				if l != nil {
					l.Close()
				}
				t.Fatal("invalid namespace qualified")
			}
			assertPreservationInventory(t, before, preservationInventory(t, root))
		})
	}
}

func TestPreservationNativePoisonsMutationReplacementRelocationAndCancellation(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, kind := range []string{"same-byte-replacement", "in-place-change", "added-file", "removed-commit", "marker-change", "claim-change", "relocation", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			root, scope, key, raw := preservationNativeFixture(t, true, true)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			l, err := AcquirePreservationInspection(ctx, root, scope, TextLimits())
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			child := filepath.Join(root.Path, resultChild)
			attempt := filepath.Join(child, key+".attempt")
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "same-byte-replacement":
				must(os.Rename(attempt, filepath.Join(root.Path, "retained-attempt")))
				must(os.WriteFile(attempt, raw, 0600))
			case "in-place-change":
				raw[len(raw)-2] ^= 1
				must(os.WriteFile(attempt, raw, 0600))
			case "added-file":
				must(os.WriteFile(filepath.Join(child, "retained-extra"), []byte("extra"), 0600))
			case "removed-commit":
				must(os.Rename(filepath.Join(child, key+".commit"), filepath.Join(root.Path, "retained-commit")))
			case "marker-change":
				must(os.WriteFile(filepath.Join(child, resultUnknown), []byte("CHANGED"), 0600))
			case "claim-change":
				must(os.WriteFile(filepath.Join(child, resultClaim), []byte("changed"), 0600))
			case "relocation":
				must(os.Rename(root.Path, root.Path+".retained"))
			case "cancel":
				cancel()
			}
			if l.Verify() == nil {
				t.Fatal("changed original namespace qualified")
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("failed original lease revived")
			}
			must(l.Close())
		})
	}
}

type preservationLagContext struct {
	context.Context
	until time.Time
	calls atomic.Int32
}

func (c *preservationLagContext) Deadline() (time.Time, bool) { c.calls.Add(1); return c.until, true }

func TestPreservationNativeCapturesDeadlineOnceWithoutTimerRenewal(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	root, scope, _, _ := preservationNativeFixture(t, true, true)
	if l, err := AcquirePreservationInspection(context.Background(), root, scope, TextLimits()); l != nil || err == nil {
		t.Fatal("unbounded claim admitted")
	}
	ctx := &preservationLagContext{Context: context.Background(), until: time.Now().Add(250 * time.Millisecond)}
	l, err := AcquirePreservationInspection(ctx, root, scope, TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	time.Sleep(time.Until(ctx.until) + time.Millisecond)
	if ctx.Err() != nil || ctx.calls.Load() != 1 || l.Verify() == nil {
		t.Fatal("deadline renewed or timer lag accepted")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("expired claim yielded metadata")
	}
}

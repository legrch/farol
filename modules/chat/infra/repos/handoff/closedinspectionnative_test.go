//go:build darwin || linux

package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

var closedInspectionNative = flag.Bool("chat-closed-inspection-native", false, "run disposable closed Chat inspection on the Lead native lane")

// Raw fixture creation, never New/Publish/recovery. Retain the entire disposable
// profile on failure. These authored tests do not inspect any owner's profile.
func closedInspectionNativeFixture(t *testing.T) (Roots, port.JournalScope) {
	t.Helper()
	base, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	parent, err := os.MkdirTemp(base, "farol-chat-handoff-closedinspection-")
	if err != nil {
		t.Fatal(err)
	}
	chat := filepath.Join(parent, "chat")
	if err := os.Mkdir(chat, 0700); err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true", parent)
	root := func(path string) Root {
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			t.Fatal(err)
		}
		return Root{Path: path, Identity: port.JournalRoot{Device: uint64(s.Dev), Inode: uint64(s.Ino), OwnerUID: s.Uid}}
	}
	roots := Roots{ProfileID: "profile", Parent: root(parent), Chat: root(chat)}
	r := historyRecord(nativeBinding(roots), "empty-origin")
	d := &memoryDisk{}
	a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
	if err := os.WriteFile(filepath.Join(chat, claimName), nil, 0600); err != nil {
		t.Fatal(err)
	}
	for index, raw := range d.records {
		sum := sha256.Sum256(raw)
		for name, content := range map[string][]byte{stepName(index+1, "attempt"): raw, stepName(index+1, "commit"): []byte(hex.EncodeToString(sum[:]))} {
			if err := os.WriteFile(filepath.Join(chat, name), content, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	return roots, a.Consumption.Next
}

type closedInspectionNativeEntry struct {
	meta   unix.Stat_t
	digest [32]byte
}

func closedInspectionNativeInventory(t *testing.T, path string) map[string]closedInspectionNativeEntry {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	result := make(map[string]closedInspectionNativeEntry)
	for _, entry := range entries {
		name := filepath.Join(path, entry.Name())
		var s unix.Stat_t
		if err := unix.Lstat(name, &s); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		result[entry.Name()] = closedInspectionNativeEntry{s, sha256.Sum256(raw)}
	}
	return result
}

func TestClosedInspectionNativeHandoffClaimHeadAndReadOnly(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	roots, scope := closedInspectionNativeFixture(t)
	before := closedInspectionNativeInventory(t, roots.Chat.Path)
	err := WithClosedInspection(context.Background(), roots, scope, func(v ClosedInspection) error {
		if v.Head == nil || !v.Head.EmptyRetirementChain || v.Head.Record.Stage != port.HandoffConsumed || v.Head.Digest != v.HeadDigest {
			t.Fatal("missing canonical internal head")
		}
		if d, err := openClosedInspectionDisk(context.Background(), roots); err == nil {
			d.close()
			t.Fatal("callback lost claim lock")
		}
		v.Head.Record.Consumption.Next.BackendGeneration = "callback-mutated"
		*v.Head.Record.Terminal.ExitCode = 99
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	after := closedInspectionNativeInventory(t, roots.Chat.Path)
	if len(before) != len(after) {
		t.Fatal("created/deleted entries")
	}
	for name, b := range before {
		a, exists := after[name]
		if !exists || !stable(b.meta, a.meta) || b.digest != a.digest {
			t.Fatal("changed entry", name)
		}
	}
	d, err := openClosedInspectionDisk(context.Background(), roots)
	if err != nil {
		t.Fatal("claim leaked", err)
	}
	if err := d.close(); err != nil {
		t.Fatal(err)
	}
}

func TestClosedInspectionNativeHandoffRefusesStagingGapsChangesAndRelocation(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	for _, kind := range []string{"unknown", "hidden-staging", "staging", "gap", "missing-claim", "claim-mode", "commit-digest", "callback-replacement", "relocation"} {
		if !t.Run(kind, func(t *testing.T) {
			roots, scope := closedInspectionNativeFixture(t)
			chat := roots.Chat.Path
			switch kind {
			case "unknown", "hidden-staging", "staging":
				name := unknownName
				if kind == "hidden-staging" {
					name = ".chat-handoff-staging"
				}
				if kind == "staging" {
					name = "chat-handoff-staging"
				}
				if err := os.WriteFile(filepath.Join(chat, name), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			case "gap":
				if err := os.Rename(filepath.Join(chat, stepName(2, "attempt")), filepath.Join(roots.Parent.Path, "retained-attempt")); err != nil {
					t.Fatal(err)
				}
			case "missing-claim":
				if err := os.Rename(filepath.Join(chat, claimName), filepath.Join(roots.Parent.Path, "retained-claim")); err != nil {
					t.Fatal(err)
				}
			case "claim-mode":
				if err := os.Chmod(filepath.Join(chat, claimName), 0644); err != nil {
					t.Fatal(err)
				}
			case "commit-digest":
				if err := os.WriteFile(filepath.Join(chat, stepName(1, "commit")), make([]byte, 64), 0600); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			err := WithClosedInspection(context.Background(), roots, scope, func(ClosedInspection) error {
				calls++
				if kind == "callback-replacement" {
					path := filepath.Join(chat, stepName(1, "attempt"))
					raw, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(path, filepath.Join(roots.Parent.Path, "retained-attempt")); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, raw, 0600); err != nil {
						t.Fatal(err)
					}
				} else if kind == "relocation" {
					if err := os.Rename(chat, filepath.Join(roots.Parent.Path, "chat.fixed-archive")); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			})
			if err == nil || kind != "callback-replacement" && kind != "relocation" && calls != 0 {
				t.Fatal("invalid observation qualified", calls, err)
			}
			if kind == "relocation" {
				chat = filepath.Join(roots.Parent.Path, "chat.fixed-archive")
			}
			if kind != "unknown" {
				if _, err := os.Lstat(filepath.Join(chat, unknownName)); !os.IsNotExist(err) {
					t.Fatal("inspection poisoned storage", err)
				}
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

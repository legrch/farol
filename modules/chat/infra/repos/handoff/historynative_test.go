//go:build darwin || linux

package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// Native lane: disposable handoff files/claim only. All retirement, completion,
// terminal and drain values are explicit fixtures. These tests supply no app,
// current reader, actual journal successor, process, Electron or provider proof.
// Names intentionally exclude the CPU-only -run '^TestHistory' lane.
func historyNativeCycle(t *testing.T, repo *Repository, r port.HandoffRecord, next port.HandoffBinding) port.HistoryAnchor {
	t.Helper()
	ctx := context.Background()
	head, err := repo.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for step := 0; step < 4; step++ {
		head, err = repo.Publish(ctx, head.Digest, r)
		if err != nil {
			t.Fatal(err)
		}
		if step < 3 {
			r = nextRecord(t, r)
			if r.Consumption != nil {
				r.Consumption.NextBinding = next
				r.Consumption.Next = port.JournalScope{ProfileID: next.ProfileID, BackendGeneration: next.BackendGeneration}
				r.Consumption.AttemptID = "attempt-" + next.BackendGeneration
			}
		}
	}
	return port.HistoryAnchor{HeadDigest: head.Digest, Consumption: *head.Record.Consumption}
}

type historyNativeFile struct {
	inode, links uint64
	mode         uint32
	size         int64
	modified     unix.Timespec
	changed      unix.Timespec
	digest       [32]byte
}

func historyNativeFiles(t *testing.T, roots Roots) map[string]historyNativeFile {
	t.Helper()
	entries, err := os.ReadDir(roots.Chat.Path)
	if err != nil {
		t.Fatal(err)
	}
	files := make(map[string]historyNativeFile)
	for _, entry := range entries {
		path := filepath.Join(roots.Chat.Path, entry.Name())
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = historyNativeFile{inode: s.Ino, links: uint64(s.Nlink), mode: uint32(s.Mode),
			size: s.Size, modified: s.Mtim, changed: s.Ctim, digest: sha256.Sum256(raw)}
	}
	return files
}

func TestNativeHistoryReopenEmptyCycleAndReadOnlyFiles(t *testing.T) {
	ctx := context.Background()
	roots := nativeRoots(t)
	r := historyRecord(nativeBinding(roots), "history-1", historyTurnSpec{"operation", "owner", false})
	repo := openRepo(t, roots)
	anchorB := historyNativeCycle(t, repo, r, historyNextBinding(r.Publication.Binding, 2))
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	repo = openRepo(t, roots)
	key := historyKey(r.Receipt.Write.Turns[0])
	check := func(a port.HistoryAnchor) {
		t.Helper()
		before := historyNativeFiles(t, roots)
		want := port.HistoryMatch{Anchor: a, Origin: r.Publication,
			PreviousRevision: r.Receipt.Write.PreviousRevision, Turn: r.Receipt.Write.Turns[0]}
		page, err := repo.HistoryPage(ctx, a, "owner", 0)
		if err != nil || page == nil || page.Total != 1 || !reflect.DeepEqual(page.Entries, []port.HistoryMatch{want}) {
			t.Fatal("native page lost exact ancestor", err)
		}
		match, err := repo.HistoryFind(ctx, a, "owner", key)
		if err != nil || match == nil || *match != want {
			t.Fatal("native find lost exact ancestor", err)
		}
		if got, err := repo.HistoryFind(ctx, a, "other-owner", key); got != nil || err != nil {
			t.Fatal("native wrong-owner leak", err)
		}
		if got, err := repo.HistoryFind(ctx, a, "owner", port.HistoryKey{BackendGeneration: key.BackendGeneration, OperationID: "missing"}); got != nil || err != nil {
			t.Fatal("native missing lookup", err)
		}
		if got, err := repo.HistoryPage(ctx, a, "owner", 1); got == nil || err != nil || got.Entries == nil || len(got.Entries) != 0 {
			t.Fatal("native end page", err)
		}
		if after := historyNativeFiles(t, roots); !reflect.DeepEqual(before, after) {
			t.Fatal("history success/missing changed files, identities or write timestamps")
		}
	}
	check(anchorB)
	emptyB := historyRecord(anchorB.Consumption.NextBinding, "history-2")
	anchorC := historyNativeCycle(t, repo, emptyB, historyNextBinding(emptyB.Publication.Binding, 3))
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	repo = openRepo(t, roots)
	check(anchorC)
	head, err := repo.Load(ctx)
	if err != nil || head.Record.Receipt.Write.Turns == nil || len(head.Record.Receipt.Write.Turns) != 0 {
		t.Fatal("native empty receipt acquired historical registry", err)
	}
	if got, err := repo.HistoryFind(ctx, anchorB, "owner", key); got != nil || !errors.Is(err, Refused) {
		t.Fatal("native stale anchor accepted", err)
	}
}

func TestNativeHistoryPhysicalAndSuffixFencesAfterMatch(t *testing.T) {
	for _, lookup := range []string{"page", "find"} {
		for _, fault := range []string{"attempt-only", "orphan-commit", "gap", "unknown-name", "malformed-suffix", "unknown-fence",
			"record-mode", "record-hardlink", "record-symlink", "record-fifo", "claim-mode", "claim-replaced", "claim-removed", "parent-mode", "chat-replaced"} {
			t.Run(lookup+"/"+fault, func(t *testing.T) {
				ctx := context.Background()
				roots := nativeRoots(t)
				repo := openRepo(t, roots)
				r := historyRecord(nativeBinding(roots), "history-1", historyTurnSpec{"operation", "owner", false})
				a := historyNativeCycle(t, repo, r, historyNextBinding(r.Publication.Binding, 2))
				empty := historyRecord(a.Consumption.NextBinding, "history-2")
				a = historyNativeCycle(t, repo, empty, historyNextBinding(empty.Publication.Binding, 3))
				path := func(name string) string { return filepath.Join(roots.Chat.Path, name) }
				must := func(err error) {
					t.Helper()
					if err != nil {
						t.Fatal(err)
					}
				}
				write := func(name string, raw []byte) { must(os.WriteFile(path(name), raw, 0600)) }
				suffix := stepName(8, "attempt") // Matching ancestor precedes this file.
				switch fault {
				case "attempt-only":
					write(stepName(9, "attempt"), []byte("{"))
				case "orphan-commit":
					write(stepName(9, "commit"), []byte("orphan"))
				case "gap":
					write(stepName(10, "attempt"), []byte("after-gap"))
				case "unknown-name":
					write("chat-handoff-unrecognized.tmp", []byte("unknown"))
				case "malformed-suffix":
					raw := []byte("{")
					write(suffix, raw)
					sum := sha256.Sum256(raw)
					write(stepName(8, "commit"), []byte(hex.EncodeToString(sum[:])))
				case "unknown-fence":
					write(unknownName, []byte("UNKNOWN"))
				case "record-mode":
					must(os.Chmod(path(suffix), 0644))
				case "record-hardlink":
					must(os.Link(path(suffix), path("linked-record")))
				case "record-symlink":
					must(os.Rename(path(suffix), path("record-target")))
					must(os.Symlink("record-target", path(suffix)))
				case "record-fifo":
					must(os.Remove(path(suffix)))
					must(unix.Mkfifo(path(suffix), 0600))
				case "claim-mode":
					must(os.Chmod(path(claimName), 0644))
				case "claim-replaced":
					must(os.Rename(path(claimName), path("original-claim")))
					write(claimName, []byte{})
				case "claim-removed":
					must(os.Remove(path(claimName)))
				case "parent-mode":
					must(os.Chmod(roots.Parent.Path, 0755))
				case "chat-replaced":
					must(os.Rename(roots.Chat.Path, roots.Chat.Path+"-original"))
					must(os.Mkdir(roots.Chat.Path, 0700))
				}
				if lookup == "page" {
					if got, err := repo.HistoryPage(ctx, a, "owner", 0); got != nil || !errors.Is(err, Unknown) {
						t.Fatal("native fault exposed page", got, err)
					}
				} else if got, err := repo.HistoryFind(ctx, a, "owner", historyKey(r.Receipt.Write.Turns[0])); got != nil || !errors.Is(err, Unknown) {
					t.Fatal("native fault exposed earlier match", got, err)
				}
				if !repo.owner.poisoned {
					t.Fatal("native failure lost sticky unknown")
				}
			})
		}
	}
}

func TestNativeHistoryClaimExclusiveAndUnknownReopen(t *testing.T) {
	ctx := context.Background()
	roots := nativeRoots(t)
	repo := openRepo(t, roots)
	r := historyRecord(nativeBinding(roots), "history-1", historyTurnSpec{"operation", "owner", false})
	a := historyNativeCycle(t, repo, r, historyNextBinding(r.Publication.Binding, 2))
	if other, err := New(ctx, roots); err == nil {
		other.Close()
		t.Fatal("second reader bypassed exclusive claim")
	}
	if err := repo.Fence(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.HistoryFind(ctx, a, "owner", historyKey(r.Receipt.Write.Turns[0])); got != nil || !errors.Is(err, Unknown) {
		t.Fatal("unknown repository exposed retained match", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := New(ctx, roots); err == nil {
		reopened.Close()
		t.Fatal("unknown history claim reopened")
	}
	for _, name := range []string{claimName, unknownName, stepName(1, "attempt"), stepName(4, "commit")} {
		if _, err := os.Lstat(filepath.Join(roots.Chat.Path, name)); err != nil {
			t.Fatal("unknown fence removed retained evidence", err)
		}
	}
}

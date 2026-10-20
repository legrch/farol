//go:build darwin || linux

package results

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

// Disposable native files only. Direct fixture records model canonical stored
// bytes WITHOUT a successful caller publication/terminal ACK; never live effects.
func archiveFixture(t *testing.T) (Root, *Archive, port.RetainRequest, *port.RetainReceipt) {
	t.Helper()
	root := nativeResultRoot(t)
	n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "create")
	q := conversationResultFixture()
	receipt := nativeResultRetain(t, n, q)
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	return root, NewArchive(root), q, receipt
}
func archiveSyntheticRecord(t *testing.T, root Root, q port.RetainRequest) string {
	t.Helper()
	var meta unix.Stat_t
	child := filepath.Join(root.Path, resultChild)
	if err := unix.Lstat(child, &meta); err != nil {
		t.Fatal(err)
	}
	raw, err := encodeResult(resultRecord{Version: 1, Root: root.Identity, StorageRoot: port.JournalRoot{Device: uint64(meta.Dev), Inode: uint64(meta.Ino), OwnerUID: meta.Uid}, Request: q})
	if err != nil {
		t.Fatal(err)
	}
	key := resultKey(q)
	digest := sha256.Sum256(raw)
	for name, data := range map[string][]byte{key + ".attempt": raw, key + ".commit": []byte(hex.EncodeToString(digest[:]))} {
		if err := os.WriteFile(filepath.Join(child, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return key
}

type archiveState struct {
	Digest [32]byte
	Meta   unix.Stat_t
	Link   string
}

func archiveSnapshot(t *testing.T, root Root) map[string]archiveState {
	t.Helper()
	out := map[string]archiveState{}
	err := filepath.Walk(root.Path, func(name string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		var meta unix.Stat_t
		if err := unix.Lstat(name, &meta); err != nil {
			return err
		}
		state := archiveState{Meta: meta}
		if info.Mode().IsRegular() {
			raw, err := os.ReadFile(name)
			if err != nil {
				return err
			}
			state.Digest = sha256.Sum256(raw)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			state.Link, err = os.Readlink(name)
			if err != nil {
				return err
			}
		}
		out[name] = state
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func archiveUnchanged(t *testing.T, root Root, before map[string]archiveState) {
	t.Helper()
	after := archiveSnapshot(t, root)
	if len(after) != len(before) {
		t.Fatal("archive changed namespace")
	}
	for name, v := range before {
		now, ok := after[name]
		if !ok || now.Digest != v.Digest || now.Link != v.Link || !resultStable(v.Meta, now.Meta) {
			t.Fatalf("archive changed original bytes/metadata: %s", name)
		}
	}
}
func TestArchiveNativeReadsStoredBytesWithUnknownFenceWithoutRetiringThem(t *testing.T) {
	root, a, q, _ := archiveFixture(t)
	child := filepath.Join(root.Path, resultChild)
	// A real storage owner publishes the retained UNKNOWN marker once; the
	// observation path must keep it and every original record byte unchanged.
	n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "open")
	if err := n.Fence(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, strings.Repeat("0", 64)+".attempt"), []byte("unacknowledged"), 0600); err != nil {
		t.Fatal(err)
	}
	before := archiveSnapshot(t, root)
	page, err := a.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner"})
	if err != nil || !page.Unresolved || len(page.Entries) != 1 || page.Next != "" || page.Entries[0].RecordedOutcome != "completed" {
		t.Fatal("valid stored observation lost", page, err)
	}
	reply, err := a.ReadStoredReply(context.Background(), port.ArchiveReadSelection{ProfileID: "profile", OwnerID: "owner", Key: page.Entries[0].Key, Digest: page.Entries[0].Digest})
	if err != nil || reply.Text != string(q.Payload) || reply.Summary != page.Entries[0] {
		t.Fatal("stored bytes not preserved", reply, err)
	}
	archiveUnchanged(t, root, before)
	if raw, err := os.ReadFile(filepath.Join(child, resultUnknown)); err != nil || string(raw) != "UNKNOWN" {
		t.Fatal("UNKNOWN removed or settled", err)
	}
}
func TestArchiveNativeConstructorAndBusyReadsNeverOpenAnotherOwner(t *testing.T) {
	root, a, _, receipt := archiveFixture(t)
	n := nativeResultOwner(t, root, scopeFixture(), TextLimits(), "open")
	before := archiveSnapshot(t, root)
	if page, err := a.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner"}); page != nil || !errors.Is(err, Unavailable) {
		t.Fatal("busy claim must be unavailable, not crossed or refused", err)
	}
	if reply, err := a.ReadStoredReply(context.Background(), port.ArchiveReadSelection{ProfileID: "profile", OwnerID: "owner", Key: resultKey(requestFixture()), Digest: receipt.Publication.Digest}); reply != nil || err == nil {
		t.Fatal("live result writer read exposed", err)
	}
	archiveUnchanged(t, root, before)
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	if page, err := a.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner"}); err != nil || len(page.Entries) != 1 {
		t.Fatal("original claim leaked after refusal", err)
	}
}
func TestArchiveNativePagesBeyondMutableStorageCapacityWithBoundedMemory(t *testing.T) {
	root, a, q, _ := archiveFixture(t)
	keys := []string{resultKey(q)}
	for i := 0; i < MaxResults+9; i++ {
		row := q
		row.Binding.OperationID = fmt.Sprintf("archive-row-%d", i)
		row.Payload = []byte(fmt.Sprintf("stored answer %d", i))
		row.Result.ID = fmt.Sprintf("result-%d", i)
		keys = append(keys, archiveSyntheticRecord(t, root, row))
	}
	foreign := q
	foreign.Binding.OwnerID = "other"
	foreign.Binding.OperationID = "other-owner"
	archiveSyntheticRecord(t, root, foreign)
	sort.Strings(keys)
	var actual []string
	after := ""
	for pages := 0; ; pages++ {
		if pages > len(keys)/port.ArchivePageSize+1 {
			t.Fatal("cursor did not advance")
		}
		page, err := a.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner", After: after})
		if err != nil || len(page.Entries) > port.ArchivePageSize || page.Unresolved {
			t.Fatal("large archive blocked by live capacity", err)
		}
		for _, entry := range page.Entries {
			actual = append(actual, entry.Key)
		}
		if page.Next == "" {
			break
		}
		if page.Next <= after {
			t.Fatal("cursor moved backwards")
		}
		after = page.Next
	}
	if !reflect.DeepEqual(actual, keys) {
		t.Fatalf("large archive truncated/mixed: %d vs %d", len(actual), len(keys))
	}
	page, err := a.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner", After: keys[len(keys)-1]})
	if err != nil || len(page.Entries) != 0 || page.Next != "" {
		t.Fatal("observed tail not empty", err)
	}
}
func TestArchiveNativeRefusesCrossedChangedAndUnsafeRecordsWithoutWrites(t *testing.T) {
	for _, kind := range []string{"profile", "owner", "root", "digest", "commit", "record", "claim-link", "record-link", "claim-hardlink", "record-hardlink", "mode", "missing-claim", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			root, a, q, receipt := archiveFixture(t)
			child := filepath.Join(root.Path, resultChild)
			key := resultKey(q)
			selection := port.ArchiveReadSelection{ProfileID: "profile", OwnerID: "owner", Key: key, Digest: receipt.Publication.Digest}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch kind {
			case "profile":
				selection.ProfileID = "other"
			case "owner":
				selection.OwnerID = "other"
			case "root":
				a.root.Identity.Inode++
			case "digest":
				selection.Digest[0]++
			case "commit":
				if err := os.WriteFile(filepath.Join(child, key+".commit"), bytes.Repeat([]byte("a"), 64), 0600); err != nil {
					t.Fatal(err)
				}
			case "record":
				if err := os.WriteFile(filepath.Join(child, key+".attempt"), []byte("{}"), 0600); err != nil {
					t.Fatal(err)
				}
			case "claim-link", "record-link":
				name := resultClaim
				if kind == "record-link" {
					name = key + ".attempt"
				}
				file := filepath.Join(child, name)
				original := filepath.Join(root.Path, "original")
				if err := os.Rename(file, original); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(original, file); err != nil {
					t.Fatal(err)
				}
			case "claim-hardlink", "record-hardlink":
				name := resultClaim
				if kind == "record-hardlink" {
					name = key + ".attempt"
				}
				if err := os.Link(filepath.Join(child, name), filepath.Join(root.Path, "additional-link")); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(filepath.Join(child, key+".attempt"), 0644); err != nil {
					t.Fatal(err)
				}
			case "missing-claim":
				if err := os.Rename(filepath.Join(child, resultClaim), filepath.Join(root.Path, "retained-claim")); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				cancel()
			}
			before := archiveSnapshot(t, root)
			reply, err := a.ReadStoredReply(ctx, selection)
			if reply != nil || err == nil {
				t.Fatal("unsafe bytes exposed", reply, err)
			}
			// An ended budget is unavailable; judged bytes that disagree refuse.
			switch kind {
			case "cancel", "profile":
				// Rejected as input before any storage observation.
				if !errors.Is(err, Invalid) {
					t.Fatal("entry validation reported as", err)
				}
			case "commit", "record", "digest", "owner":
				if !errors.Is(err, Refused) {
					t.Fatal("judged mismatch reported as", err)
				}
			}
			archiveUnchanged(t, root, before)
			if _, err := os.Lstat(filepath.Join(child, resultUnknown)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed inspection poisoned storage", err)
			}
		})
	}
}
func TestArchiveNativeMissingNamespaceAndRelocationAreNotEmptyRecovery(t *testing.T) {
	root := nativeResultRoot(t)
	a := NewArchive(root)
	before := archiveSnapshot(t, root)
	if page, err := a.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: "profile", OwnerID: "owner"}); page != nil || !errors.Is(err, Unavailable) {
		t.Fatal("missing namespace must be unavailable, never empty", err)
	}
	archiveUnchanged(t, root, before)
	root, _, _, _ = archiveFixture(t)
	disk, err := openArchiveDisk(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer disk.d.close()
	moved := root.Path + "-retained"
	if err := os.Rename(root.Path, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Rename(moved, root.Path); err != nil {
			t.Error(err)
		}
	})
	if err := disk.verify(context.Background()); err == nil {
		t.Fatal("relocated root qualified")
	}
}

// endsAfter reports a live context for its first n Err calls, then Canceled:
// a deterministic budget that ends while a file is being read.
type endsAfter struct {
	context.Context
	n int
}

func (c *endsAfter) Err() error {
	if c.n > 0 {
		c.n--
		return nil
	}
	return context.Canceled
}

func TestArchiveBudgetEndingMidReadIsUnavailableNotRefused(t *testing.T) {
	root, a, q, receipt := archiveFixture(t)
	disk, err := openArchiveDisk(context.Background(), a.root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = disk.d.close() }()
	// archiveFile checks the budget on entry and again after the read.
	if _, err := archiveFile(&endsAfter{Context: context.Background(), n: 1}, disk.d, resultKey(q)+".attempt", port.MaxResultRecordBytes); !errors.Is(err, Unavailable) {
		t.Fatal("budget ending mid-read reported as", err)
	}
	if _, _, err := disk.record(&endsAfter{Context: context.Background(), n: 3}, resultKey(q)); !errors.Is(err, Unavailable) {
		t.Fatal("budget ending during the commit read reported as", err)
	}
	if raw, err := archiveFile(context.Background(), disk.d, resultKey(q)+".attempt", port.MaxResultRecordBytes); err != nil || len(raw) == 0 {
		t.Fatal("live budget refused", err)
	}
	_ = root
	_ = receipt
}

func TestObservedKeepsUnavailableApartFromRefusal(t *testing.T) {
	if !errors.Is(observed(Unavailable), Unavailable) || !errors.Is(observed(Refused), Refused) || !errors.Is(observed(errors.New("other")), Refused) {
		t.Fatal("classification lost")
	}
}

func TestArchiveOpenFailuresSeparateUnavailableStoreFromRefusedNames(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want error
	}{
		{unix.ENOENT, Unavailable}, {unix.EIO, Unavailable}, {unix.EINTR, Unavailable},
		{unix.EMFILE, Unavailable}, {unix.ELOOP, Refused}, {unix.EACCES, Refused}, {unix.ENOTDIR, Refused},
	} {
		if got := openFailure(tc.err); !errors.Is(got, tc.want) {
			t.Fatalf("%v -> %v, want %v", tc.err, got, tc.want)
		}
	}
	// A committed record whose attempt file is gone is unavailable, not tampering;
	// a symlinked attempt still refuses (covered by the record-link case above).
	root, a, q, _ := archiveFixture(t)
	disk, err := openArchiveDisk(context.Background(), a.root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = disk.d.close() }()
	if _, err := archiveFile(context.Background(), disk.d, resultKey(q)+".missing", port.MaxResultRecordBytes); !errors.Is(err, Unavailable) {
		t.Fatal("missing file reported as", err)
	}
	_ = root
}

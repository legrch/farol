//go:build darwin || linux

package results

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

func retiredFixture(t *testing.T) (Root, Root, *RetiredArchive) {
	t.Helper()
	old, _, _, _ := archiveFixture(t)
	parent := filepath.Dir(old.Path)
	if err := os.Chmod(parent, 0700); err != nil {
		t.Fatal(err)
	}
	next := filepath.Join(parent, "chat-retired-11111111-1111-4111-8111-111111111111")
	if err := os.Rename(old.Path, next); err != nil {
		t.Fatal(err)
	}
	old.Path = next
	var meta unix.Stat_t
	if err := unix.Lstat(parent, &meta); err != nil {
		t.Fatal(err)
	}
	profile := Root{Path: parent, ProfileID: old.ProfileID, Identity: port.JournalRoot{Device: uint64(meta.Dev), Inode: uint64(meta.Ino), OwnerUID: meta.Uid}}
	return profile, old, NewRetiredArchive(profile)
}

func TestRetiredArchivePagesAcrossNamespacesAndNeverOpensActiveWriter(t *testing.T) {
	profile, old, reader := retiredFixture(t)
	active := nativeResultRoot(t)
	activePath := filepath.Join(profile.Path, "chat")
	if err := os.Rename(active.Path, activePath); err != nil {
		t.Fatal(err)
	}
	active.Path = activePath
	writer := nativeResultOwner(t, active, scopeFixture(), TextLimits(), "create")
	defer writer.Close()
	// A second archive deliberately has the same original result key. The
	// aggregate key must select its namespace without minting a handoff origin.
	second, _, q, _ := archiveFixture(t)
	secondPath := filepath.Join(profile.Path, "chat-retired-22222222-2222-4222-8222-222222222222")
	if err := os.Rename(second.Path, secondPath); err != nil {
		t.Fatal(err)
	}
	second.Path = secondPath
	for i := 0; i < 70; i++ {
		q.Binding.OperationID = fmt.Sprintf("stored-%03d", i)
		q.Result.ID = fmt.Sprintf("result-%03d", i)
		q.Payload = []byte(fmt.Sprintf("Synthetic retained copy %d <script>literal</script>", i))
		archiveSyntheticRecord(t, old, q)
		q.Payload = []byte(fmt.Sprintf("Other original namespace %d", i))
		archiveSyntheticRecord(t, second, q)
	}
	before := archiveSnapshot(t, profile)
	seen := map[string]bool{}
	after := ""
	count := 0
	for {
		page, err := reader.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: profile.ProfileID, OwnerID: q.Binding.OwnerID, After: after})
		if err != nil || page == nil || len(page.Entries) > 32 {
			t.Fatal(page, err)
		}
		for _, summary := range page.Entries {
			if summary.Key <= after || seen[summary.Key] {
				t.Fatal("crossed or duplicate aggregate page")
			}
			seen[summary.Key] = true
			count++
			reply, err := reader.ReadStoredReply(context.Background(), port.ArchiveReadSelection{ProfileID: profile.ProfileID, OwnerID: q.Binding.OwnerID, Key: summary.Key, Digest: summary.Digest})
			if err != nil || reply == nil || reply.Summary != summary || reply.Text == "" {
				t.Fatal(reply, err)
			}
		}
		if page.Next == "" {
			break
		}
		if len(page.Entries) != 32 || page.Next != page.Entries[31].Key {
			t.Fatal("cursor not exact")
		}
		after = page.Next
	}
	if count != 142 {
		t.Fatalf("lost namespace replies: %d", count)
	}
	archiveUnchanged(t, profile, before)
}

func TestRetiredArchiveRefusesUnsafeNamespaceAndChangedPinsWithoutRepair(t *testing.T) {
	for _, kind := range []string{"symlink", "mode", "device", "stored-device", "busy", "digest", "owner"} {
		t.Run(kind, func(t *testing.T) {
			profile, old, reader := retiredFixture(t)
			q := conversationResultFixture()
			selection := port.ArchiveListSelection{ProfileID: profile.ProfileID, OwnerID: q.Binding.OwnerID}
			page, err := reader.ListStoredReplies(context.Background(), selection)
			if err != nil || len(page.Entries) != 1 {
				t.Fatal(page, err)
			}
			entry := page.Entries[0]
			switch kind {
			case "symlink":
				if err := os.Symlink(old.Path, filepath.Join(profile.Path, "chat-retired-33333333-3333-4333-8333-333333333333")); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(old.Path, 0755); err != nil {
					t.Fatal(err)
				}
			case "device":
				reader = NewRetiredArchive(Root{Path: profile.Path, ProfileID: profile.ProfileID, Identity: port.JournalRoot{Device: profile.Identity.Device + 1, Inode: profile.Identity.Inode, OwnerUID: profile.Identity.OwnerUID}})
			case "stored-device":
				// Model the observed durable-device mismatch without rewriting it
				// during observation or granting a new identity to the old store.
				claim := filepath.Join(old.Path, resultChild, resultClaim)
				raw, err := os.ReadFile(claim)
				if err != nil {
					t.Fatal(err)
				}
				var value resultClaimRecord
				if err := json.Unmarshal(raw, &value); err != nil {
					t.Fatal(err)
				}
				value.Root.Device++
				value.StorageRoot.Device++
				raw, err = json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(claim, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "busy":
				claim, err := os.Open(filepath.Join(old.Path, resultChild, resultClaim))
				if err != nil {
					t.Fatal(err)
				}
				defer claim.Close()
				if err := unix.Flock(int(claim.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
					t.Fatal(err)
				}
			case "digest":
				entry.Digest[0] ^= 1
			case "owner":
				selection.OwnerID = "different-owner"
			}
			before := archiveSnapshot(t, profile)
			reply, err := reader.ReadStoredReply(context.Background(), port.ArchiveReadSelection{ProfileID: profile.ProfileID, OwnerID: selection.OwnerID, Key: entry.Key, Digest: entry.Digest})
			if err == nil || reply != nil {
				t.Fatal("unsafe retired read accepted", reply)
			}
			archiveUnchanged(t, profile, before)
		})
	}
}

func TestRetiredArchiveEmptyMalformedAndCanceledObservations(t *testing.T) {
	profile, _, reader := retiredFixture(t)
	q := conversationResultFixture()
	if err := os.Mkdir(filepath.Join(profile.Path, "chat-retired-not-a-token"), 0700); err != nil {
		t.Fatal(err)
	}
	before := archiveSnapshot(t, profile)
	page, err := reader.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: profile.ProfileID, OwnerID: q.Binding.OwnerID})
	if err != nil || !page.Unresolved || len(page.Entries) != 1 {
		t.Fatal(page, err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if page, err := reader.ListStoredReplies(canceled, port.ArchiveListSelection{ProfileID: profile.ProfileID, OwnerID: q.Binding.OwnerID}); err == nil || page != nil {
		t.Fatal("canceled list published")
	}
	if page, err := reader.ListStoredReplies(context.Background(), port.ArchiveListSelection{ProfileID: profile.ProfileID, OwnerID: q.Binding.OwnerID, After: strings.Repeat("x", 64)}); err == nil || page != nil {
		t.Fatal("invalid cursor accepted")
	}
	archiveUnchanged(t, profile, before)
	// Constructor selection itself never opens or creates a namespace.
	missing := filepath.Join(profile.Path, "does-not-exist")
	_ = NewRetiredArchive(Root{Path: missing, ProfileID: profile.ProfileID, Identity: profile.Identity})
	if _, err := os.Lstat(missing); !os.IsNotExist(err) {
		t.Fatal("constructor did IO")
	}
	if !reflect.DeepEqual(before, archiveSnapshot(t, profile)) {
		t.Fatal("constructor changed profile")
	}
}

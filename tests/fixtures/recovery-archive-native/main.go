// Command recovery-archive-native prepares synthetic stored copies only inside
// an explicitly owned disposable E2E profile after its original Go child exits.
// It uses real result retention and Fence, but creates no real Browser Send,
// terminal lifecycle, ACK, HistoryOrigin or interrupted workspace operation.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/results"
	"golang.org/x/sys/unix"
)

type stored struct {
	Operation string `json:"operationId"`
	Key       string `json:"key"`
	Digest    string `json:"digest"`
	Text      string `json:"text"`
}

func main() {
	if len(os.Args) != 5 {
		panic("explicit owned profile, proof, profile ID and original generation required")
	}
	profile, proof, profileID, generation := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	base, err := filepath.EvalSymlinks(os.TempDir())
	must(err)
	canonical, err := filepath.EvalSymlinks(profile)
	must(err)
	if canonical != profile || filepath.Dir(profile) != base || !strings.HasPrefix(filepath.Base(profile), "farol-dev-onboarding-startup-") {
		panic("not the owned disposable E2E profile")
	}
	marker := filepath.Join(profile, ".farol-next-e2e-root")
	var physical unix.Stat_t
	must(unix.Lstat(marker, &physical))
	if physical.Mode&unix.S_IFMT != unix.S_IFREG || physical.Mode&07777 != 0600 || physical.Uid != uint32(os.Geteuid()) || physical.Nlink != 1 {
		panic("invalid owned marker")
	}
	bytes, err := os.ReadFile(marker)
	must(err)
	if string(bytes) != proof || len(proof) != 36 {
		panic("owned marker mismatch")
	}
	chat := filepath.Join(profile, "app-data", "Farol Dev", "farol-next-state", "go-core", "chat")
	must(unix.Lstat(chat, &physical))
	root := results.Root{Path: chat, ProfileID: profileID, Identity: port.JournalRoot{Device: uint64(physical.Dev), Inode: uint64(physical.Ino), OwnerUID: physical.Uid}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, err := results.NewNative(ctx, ctx, root, port.JournalScope{ProfileID: profileID, BackendGeneration: generation}, results.TextLimits(), "open")
	must(err)
	// Never remove/repair a prior unknown fence or retry a failed publication.
	records := make([]stored, 0, 33)
	for i := 1; i <= 33; i++ {
		text := fmt.Sprintf("Synthetic stored reply %02d\n<script>plain text only</script>\nOutcome remains unconfirmed. ✓", i)
		q := port.RetainRequest{Binding: port.TurnBinding{ProfileID: profileID, BackendGeneration: generation, OwnerID: "owner-desktop", SessionID: "fixture-session", TaskID: "fixture-task", TaskEpoch: 1, ParticipantID: "fixture-participant", TurnID: fmt.Sprintf("fixture-turn-%d", i), OperationID: fmt.Sprintf("fixture-result-operation-%d", i), TurnGeneration: 1}, Result: turn.Result{ID: fmt.Sprintf("fixture-result-%d", i), Outcome: turn.Completed, Code: "COMPLETED"}, Payload: []byte(text)}
		receipt, err := owner.Retain(ctx, q)
		must(err)
		records = append(records, stored{Operation: q.Binding.OperationID, Digest: hex.EncodeToString(receipt.Publication.Digest[:]), Text: text})
	}
	must(owner.Fence(ctx))
	must(owner.Close())
	archive := results.NewArchive(root)
	seen := 0
	for after := ""; ; {
		page, err := archive.ListStoredReplies(ctx, port.ArchiveListSelection{ProfileID: profileID, OwnerID: "owner-desktop", After: after})
		must(err)
		if !page.Unresolved {
			panic("original UNKNOWN was not observed")
		}
		for _, entry := range page.Entries {
			found := false
			for i := range records {
				if records[i].Operation == entry.OperationID && records[i].Digest == hex.EncodeToString(entry.Digest[:]) && records[i].Key == "" {
					records[i].Key = entry.Key
					seen++
					found = true
					break
				}
			}
			if !found {
				panic("stored observation differs from the original Retain receipt")
			}
		}
		if page.Next == "" {
			break
		}
		after = page.Next
	}
	if seen != len(records) {
		panic("missing stored fixture record")
	}
	must(json.NewEncoder(os.Stdout).Encode(struct {
		Kind    string   `json:"kind"`
		Entries []stored `json:"entries"`
	}{"synthetic-native-retain-then-UNKNOWN-without-terminal-or-ACK", records}))
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}

//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"golang.org/x/sys/unix"
)

// Actual selected Go composition/stores over disposable native state only.
// No backend OS child, Electron, provider, interrupted workspace effect or old
// terminal/ACK is supplied; stored data remains explicitly unconfirmed.
func TestNativeRecoveryArchiveRetainsUnknownResultsWithoutAHandoffOrigin(t *testing.T) {
	launch, old := retirementStorageFixture(t, true)
	normal, err := old.Methods()
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"chat.archive.list", "chat.archive.read"} {
		if _, ok := normal[method]; ok {
			t.Fatal("diagnostic recovery leaked into normal owner")
		}
	}
	q := chatport.RetainRequest{Binding: chatport.TurnBinding{ProfileID: launch.Profile.ProfileID, BackendGeneration: "generation-1", OwnerID: launch.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", OperationID: "stored-without-terminal", TurnGeneration: 1}, Result: turn.Result{ID: "stored-result", Outcome: turn.Completed, Code: "COMPLETED"}, Payload: []byte("Synthetic retained answer without terminal ACK")}
	if _, err := old.results.Retain(context.Background(), q); err != nil {
		t.Fatal(err)
	}
	if err := old.results.Fence(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode, launch.StartupMode = "open", "recovery"
	launch.SettingsMutations = false
	launch.PreviousHostDrainConfirmed = false
	launch.HostLifetimeID, launch.ChildLaunchID = "archive-host", "archive-child"
	before := recoverySnapshot(t, launch.Profile.Root)
	r, err := NewNativeRecovery(context.Background(), launch, "archive-generation")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	out := recoveryCall(t, r, "chat.archive.list", "", wire.ChatArchiveListRequest{After: ""})
	var page wire.ChatArchivePage
	if out.Status != "ok" || json.Unmarshal(out.Data, &page) != nil || page.Observation != "stored_unconfirmed" || !page.Unresolved || len(page.Entries) != 1 {
		t.Fatal("stored observation unavailable without handoff", out)
	}
	entry := page.Entries[0]
	out = recoveryCall(t, r, "chat.archive.read", "", wire.ChatArchiveReadRequest{Key: entry.Key, Digest: entry.Digest})
	var reply wire.ChatArchiveReply
	if out.Status != "ok" || json.Unmarshal(out.Data, &reply) != nil || reply.Observation != "stored_unconfirmed" || reply.Text != string(q.Payload) || reply.Summary.RecordedOutcome != "completed" || reply.Summary.ConversationId != "" {
		t.Fatal("stored text lost or promoted", out)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if after := recoverySnapshot(t, launch.Profile.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("archive queries/Close changed retained state")
	}
}
func TestNativeRecoveryStartsWhileArchiveClaimIsBusyOrNamespaceIsMissing(t *testing.T) {
	for _, kind := range []string{"busy", "missing"} {
		t.Run(kind, func(t *testing.T) {
			launch, old := retirementStorageFixture(t, true)
			if err := old.Close(); err != nil {
				t.Fatal(err)
			}
			child := filepath.Join(launch.Profile.Root, "chat", "chat-results")
			var claim *os.File
			if kind == "busy" {
				var err error
				claim, err = os.Open(filepath.Join(child, "chat-results.claim"))
				if err != nil {
					t.Fatal(err)
				}
				defer claim.Close()
				if err := unix.Flock(int(claim.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Rename(child, filepath.Join(launch.Profile.Root, "chat", "retained-results")); err != nil {
				t.Fatal(err)
			}
			launch.StoreMode, launch.StartupMode = "open", "recovery"
			launch.SettingsMutations = false
			launch.PreviousHostDrainConfirmed = false
			launch.HostLifetimeID, launch.ChildLaunchID = "archive-host", "archive-child"
			before := recoverySnapshot(t, launch.Profile.Root)
			r, err := NewNativeRecovery(context.Background(), launch, "archive-generation")
			if err != nil {
				t.Fatal("archive vetoed independent recovery", err)
			}
			defer r.Close()
			out := recoveryCall(t, r, "chat.archive.list", "", wire.ChatArchiveListRequest{After: ""})
			if out.Status != "unavailable" || len(out.Data) != 0 {
				t.Fatal("unqualified archive became empty data", out)
			}
			if _, err := r.Methods(); err != nil {
				t.Fatal("archive read failure poisoned independent recovery", err)
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			if after := recoverySnapshot(t, launch.Profile.Root); !reflect.DeepEqual(before, after) {
				t.Fatal("failed archive query changed retained state")
			}
		})
	}
}

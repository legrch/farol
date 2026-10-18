//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/transport/desktop"
	"golang.org/x/sys/unix"
)

// Real disposable stores, descriptor locks and archive reader. No OS child,
// original profile, native Close failure, previous effect or terminal ACK.
func TestNativeRecoveryArchiveSurvivesQualifiedComputerRefusal(t *testing.T) {
	for _, fault := range []string{"invalid-snapshot", "busy-lock"} {
		t.Run(fault, func(t *testing.T) {
			launch, old := retirementStorageFixture(t, true)
			q := chatport.RetainRequest{Binding: chatport.TurnBinding{ProfileID: launch.Profile.ProfileID, BackendGeneration: "generation-1", OwnerID: launch.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", OperationID: "independent-stored-copy", TurnGeneration: 1}, Result: turn.Result{ID: "unconfirmed-result", Outcome: turn.Completed, Code: "COMPLETED"}, Payload: []byte("Synthetic retained text beside refused Computer")}
			if _, err := old.results.Retain(context.Background(), q); err != nil {
				t.Fatal(err)
			}
			if err := old.results.Fence(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := old.Close(); err != nil {
				t.Fatal(err)
			}
			computer := filepath.Join(launch.Profile.Root, "computer")
			snapshot := filepath.Join(computer, "computer-access.json")
			if fault == "invalid-snapshot" {
				if err := os.WriteFile(snapshot, []byte("{invalid fixture snapshot\n"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				lock, err := os.OpenFile(filepath.Join(computer, "computer-access.lock"), os.O_RDWR, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer lock.Close()
				if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
					t.Fatal(err)
				}
			}
			original, err := os.ReadFile(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			before := recoverySnapshot(t, launch.Profile.Root)
			launch.StoreMode, launch.StartupMode, launch.SettingsMutations = "open", "recovery", false
			launch.HostLifetimeID, launch.ChildLaunchID = "independent-host", "independent-child"
			r, err := NewNativeRecovery(context.Background(), launch, "independent-generation")
			if err != nil {
				t.Fatal("independent archive owner refused", err)
			}
			defer r.Close()
			if r.store != nil || r.ingress != nil {
				t.Fatal("Computer refusal became authority")
			}
			methods, err := r.Methods()
			if err != nil {
				t.Fatal(err)
			}
			names := make([]string, 0, len(methods))
			for name := range methods {
				names = append(names, name)
			}
			slices.Sort(names)
			if !reflect.DeepEqual(names, []string{"chat.archive.list", "chat.archive.read"}) {
				t.Fatal("unavailable Computer advertised methods", names)
			}
			out := recoveryCall(t, r, "chat.archive.list", "", wire.ChatArchiveListRequest{After: ""})
			var page wire.ChatArchivePage
			if out.Status != "ok" || json.Unmarshal(out.Data, &page) != nil || page.Observation != "stored_unconfirmed" || !page.Unresolved || len(page.Entries) != 1 {
				t.Fatal("independent stored copy unavailable", out)
			}
			e := page.Entries[0]
			out = recoveryCall(t, r, "chat.archive.read", "", wire.ChatArchiveReadRequest{Key: e.Key, Digest: e.Digest})
			var reply wire.ChatArchiveReply
			if out.Status != "ok" || json.Unmarshal(out.Data, &reply) != nil || reply.Text != string(q.Payload) || reply.Observation != "stored_unconfirmed" {
				t.Fatal("stored copy lost or promoted", out)
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			if out, err := methods["chat.archive.list"].Handle(context.Background(), desktop.Request{Body: []byte(`{"after":""}`)}); err == nil || out != nil {
				t.Fatal("retained method escaped closed owner", out, err)
			}
			if after := recoverySnapshot(t, launch.Profile.Root); !reflect.DeepEqual(before, after) {
				t.Fatal("independent read changed retained state")
			}
			if after, err := os.ReadFile(snapshot); err != nil || string(after) != string(original) {
				t.Fatal("refused Computer snapshot changed", err)
			}
		})
	}
}

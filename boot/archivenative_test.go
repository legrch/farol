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
	"github.com/legrch/farol/transport/desktop"
)

func TestNativeNormalRetiredArchiveIsIndependentOfActiveWriter(t *testing.T) {
	launch, current := retirementStorageFixture(t, true)
	oldLaunch, old := retirementStorageFixture(t, true)
	q := chatport.RetainRequest{Binding: chatport.TurnBinding{ProfileID: launch.Profile.ProfileID, BackendGeneration: "generation-1", OwnerID: launch.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", OperationID: "interrupted-stored-copy", TurnGeneration: 1}, Result: turn.Result{ID: "unconfirmed-result", Outcome: turn.Completed, Code: "COMPLETED"}, Payload: []byte("Synthetic unconfirmed copy <script>literal</script>")}
	if _, err := old.results.Retain(context.Background(), q); err != nil {
		t.Fatal(err)
	}
	if err := old.results.Fence(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}
	// Explicit native fixture relocation, not an actual host crash or an ACK.
	if err := os.Rename(filepath.Join(oldLaunch.Profile.Root, "chat"), filepath.Join(launch.Profile.Root, "chat-retired-11111111-1111-4111-8111-111111111111")); err != nil {
		t.Fatal(err)
	}
	methods, err := current.Methods()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"chat.archive.list", "chat.archive.read"} {
		if _, ok := methods[name]; ok {
			t.Fatal("active recovery reader exported by normal owner")
		}
	}
	call := func(name string, value any) *desktop.Outcome {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		method, ok := methods[name]
		if !ok {
			t.Fatal("retired method absent", name)
		}
		out, err := method.Handle(context.Background(), desktop.Request{Body: raw})
		if err != nil || out == nil {
			t.Fatal(out, err)
		}
		return out
	}
	before := recoverySnapshot(t, launch.Profile.Root)
	out := call("chat.retired.list", wire.ChatArchiveListRequest{After: ""})
	var page wire.ChatArchivePage
	if out.Status != "ok" || json.Unmarshal(out.Data, &page) != nil || page.Observation != "stored_unconfirmed" || !page.Unresolved || len(page.Entries) != 1 {
		t.Fatal("retired copy unavailable beside active writer", out)
	}
	entry := page.Entries[0]
	out = call("chat.retired.read", wire.ChatArchiveReadRequest{Key: entry.Key, Digest: entry.Digest})
	var reply wire.ChatArchiveReply
	if out.Status != "ok" || json.Unmarshal(out.Data, &reply) != nil || reply.Observation != "stored_unconfirmed" || reply.Text != string(q.Payload) {
		t.Fatal("stored copy promoted or lost", out)
	}
	if after := recoverySnapshot(t, launch.Profile.Root); !reflect.DeepEqual(before, after) {
		t.Fatal("retired query changed original state")
	}
}

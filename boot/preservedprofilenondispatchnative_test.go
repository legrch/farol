//go:build darwin

package boot

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// Actual Go command and disposable native filesystem. The test alone observes
// the original command return; missing publication/pending cannot supply that
// historical terminal to a later host. No Electron, provider or daily profile.
func TestPreservedProfileMissingPublicationAndIntentDoNotProveNondispatch(t *testing.T) {
	for _, dispatched := range []bool{false, true} {
		name := "not-dispatched"
		if dispatched {
			name = "dispatched-before-pending"
		}
		t.Run(name, func(t *testing.T) {
			in, _ := preservedProfileFixture(t, true)
			retained := filepath.Join(in.Profile.Root, "chat", "chat-results", "chat-results.unknown")
			old, err := os.ReadFile(retained)
			if err != nil || string(old) != "UNKNOWN" {
				t.Fatal("missing original UNKNOWN fixture", err)
			}
			before := recoverySnapshot(t, in.Profile.Root)
			if dispatched {
				profile := in.Profile
				in.Profile = ProfileBinding{}
				// A launched command can reject its stale independent claim
				// before it creates intent or publishes an initiating ACK.
				in.Selection.HandoffDigest[0]++
				raw, err := json.Marshal(in)
				if err != nil {
					t.Fatal(err)
				}
				p := newPreservedCommandPipe(t)
				p.start(t, preservedCommandNativeArgs(profile), time.Now().Add(3*time.Second), false, p.output)
				p.send(t, append(raw, '\n'))
				p.finish(t, 1)
				publication, err := io.ReadAll(p.reader)
				if err != nil || len(publication) != 0 {
					t.Fatal("unexpected publication", err)
				}
				in.Profile = profile
			}
			if _, err := os.Lstat(emptyRecoveryPendingPath(in.Profile.Root)); !os.IsNotExist(err) {
				t.Fatal("unexpected pending intent", err)
			}
			archives, err := filepath.Glob(filepath.Join(in.Profile.Root, "chat-retired-*"))
			if err != nil || len(archives) != 0 {
				t.Fatal("unexpected new archive", err)
			}
			after, err := os.ReadFile(retained)
			if err != nil || string(after) != string(old) || !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
				t.Fatal("original UNKNOWN/state changed", err)
			}
			t.Log("No publication, no intent, no archive, original state exact; these facts alone do not classify dispatch")
		})
	}
}

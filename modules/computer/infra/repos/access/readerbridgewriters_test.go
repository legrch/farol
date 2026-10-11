package access

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Real disposable Store/disk paths; no installed profile or live admission.
func TestReaderBridgeWritersPreserveNoAccessRefusal(t *testing.T) {
	for _, action := range []string{"approval", "publication", "admit", "delegate", "delegate-retained"} {
		t.Run(action, func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			admit(t, f)
			file := filepath.Join(f.root, stateName)
			if action == "delegate-retained" {
				// Model a future snapshot before opening this reader generation.
				if err := f.store.Close(); err != nil {
					t.Fatal(err)
				}
				n := f.store.current
				n.Approval.Workspaces, n.Approval.Capabilities = nil, nil
				for id, item := range n.Participants {
					item.Value.Grant.Workspaces, item.Value.Grant.Capabilities = nil, nil
					n.Participants[id] = item
				}
				raw, err := encodeState(testBinding, n)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, raw, 0600); err != nil {
					t.Fatal(err)
				}
				f.store, err = Open(f.root, testBinding, f.clock)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { f.store.Close() })
			}
			before := status(t, f.store)
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			value := f.approval.Clone()
			value.Generation++
			value.Workspaces, value.Capabilities = nil, nil
			published := false
			switch action {
			case "approval":
				err = f.store.UpdateApproval(context.Background(), before.Revision, value)
			case "publication":
				err = f.store.UpdateApprovalWithPublication(context.Background(), before.Revision, value, func(publish func() error) error { published = true; return publish() })
			case "admit":
				input := f.admission
				input.Workspaces, input.Capabilities = nil, nil
				identity := f.participant
				identity.ParticipantID = "empty"
				_, err = f.store.Admit(context.Background(), before.Revision, input, identity)
			case "delegate", "delegate-retained":
				input := authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: "empty-child", Role: authority.Critic, MutationOwnership: authority.NoOwnership}}
				if action == "delegate" {
					input.Narrowing = &authority.Narrowing{Network: authority.NoNetwork, Commands: authority.NoCommands}
				}
				_, err = f.store.Delegate(context.Background(), before.Revision, "main", input)
			}
			failCode(t, err, "AUTHORITY_INFLATION_DENIED")
			if published || status(t, f.store) != before {
				t.Fatal("reader bridge published new empty authority")
			}
			after, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(raw, after) {
				t.Fatal("refused writer changed retained snapshot")
			}
		})
	}
}

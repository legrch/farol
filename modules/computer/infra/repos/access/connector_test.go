package access

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"golang.org/x/sys/unix"
)

// NATIVE TESTS: NOT RUN in the bounded connector writer task. These use the
// existing disposable native Store fixture. They do not qualify transport auth,
// actual host lifecycle, an MCP client, an installed app or a provider route.
func connectorInput(f stateFixture) port.ConnectorLaunch {
	return port.ConnectorLaunch{
		Host:      port.ConnectorHost{ProfileID: testBinding.ProfileID, BackendGeneration: "backend", BuildID: "build", RuntimeID: "runtime", ConnectorGeneration: 1, LaunchDigest: "digest"},
		Admission: f.admission, Participant: f.participant, TurnCorrelation: "root-correlation", Approval: f.approval,
	}
}

func TestNativeConnectorJournalOriginalPublicationAndWithdrawal(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r, err := NewConnectorJournal(f.store)
	if err != nil {
		t.Fatal(err)
	}
	before := status(t, f.store).Revision
	p, err := r.PublishConnector(context.Background(), connectorInput(f))
	if err != nil || !p.OriginalPublished || p.Revision != before+1 {
		t.Fatal("missing original readback", p, err)
	}
	v := snapshot(t, f.store, f.participant.ParticipantID)
	if v.Participant == nil || !authority.SameParticipantCeiling(*v.Participant, p.Participant) {
		t.Fatal("wrong original participant")
	}
	// Neither exact duplicates nor conflicting reconstructed IDs restore liveness.
	for _, conflict := range []bool{false, true} {
		input := connectorInput(f)
		if conflict {
			input.Admission.TaskEpoch++
		}
		out, err := r.PublishConnector(context.Background(), input)
		if err == nil || out.OriginalPublished || status(t, f.store).Revision != p.Revision {
			t.Fatal("persisted participant restored", out, err)
		}
	}
	if err := r.WithdrawConnector(context.Background(), f.participant.ParticipantID); err != nil {
		t.Fatal(err)
	}
	if status(t, f.store).Revision != p.Revision+1 || snapshot(t, f.store, f.participant.ParticipantID).Participant != nil {
		t.Fatal("revocation not read back")
	}
	if out, err := r.PublishConnector(context.Background(), connectorInput(f)); err == nil || out.OriginalPublished {
		t.Fatal("revoked participant restored")
	}
}

func TestNativeConnectorJournalUnknownCommitNeverReturnsOriginal(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r, err := NewConnectorJournal(f.store)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	f.store.disk.syncDirectory = func(int) error { calls++; return unix.EIO }
	out, err := r.PublishConnector(context.Background(), connectorInput(f))
	if !OutcomeUnknown(err) || out.OriginalPublished || calls != 1 {
		t.Fatal("unknown publication accepted", out, err, calls)
	}
	if out, err = r.PublishConnector(context.Background(), connectorInput(f)); err == nil || out.OriginalPublished || calls != 1 {
		t.Fatal("poisoned store replayed", out, err, calls)
	}
}

func TestNativeConnectorJournalChangedApprovalRefusesBeforePublication(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r, err := NewConnectorJournal(f.store)
	if err != nil {
		t.Fatal(err)
	}
	input := connectorInput(f)
	input.Approval.Workspaces = append([]authority.ApprovedWorkspace(nil), input.Approval.Workspaces...)
	input.Approval.Workspaces[0].Root = "/other"
	before := status(t, f.store).Revision
	out, err := r.PublishConnector(context.Background(), input)
	if err == nil || out.OriginalPublished || status(t, f.store).Revision != before {
		t.Fatal("changed seal published", out, err)
	}
}

func TestNativeConnectorJournalWrongProfileRefusesBeforePublication(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r, err := NewConnectorJournal(f.store)
	if err != nil {
		t.Fatal(err)
	}
	input := connectorInput(f)
	input.Host.ProfileID = "different-profile"
	before := status(t, f.store).Revision
	out, err := r.PublishConnector(context.Background(), input)
	if err == nil || out.OriginalPublished || status(t, f.store).Revision != before {
		t.Fatal("wrong profile published", out, err)
	}
}

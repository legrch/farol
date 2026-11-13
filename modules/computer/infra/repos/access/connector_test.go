package access

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

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

// predecessorAcceptsState encodes how the retained predecessor image (0.5.24,
// main 9de07bcf) opens computer-access.json while it opens the Computer Store.
// state.go, disk.go and domain/authority are unchanged since that commit, so
// decodeState here is its exact reader; the literal 256 pins the predecessor's
// participant bound even if this build's constant ever moves. A refusal fails
// the predecessor's whole Store constructor.
func predecessorAcceptsState(root string, b Binding) error {
	info, err := os.Lstat(filepath.Join(root, stateName))
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return errors.New("state file refused")
	}
	raw, err := os.ReadFile(filepath.Join(root, stateName))
	if err != nil {
		return err
	}
	var d document
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&d) != nil || d.Schema != 1 || d.Participants == nil || len(d.Participants) > 256 {
		return errors.New("schema or participant bound refused")
	}
	_, err = decodeState(b, raw)
	return err
}

// A resume writes nothing and reads back only the exact live participant:
// many reconnects keep one durable record, which the predecessor still opens.
// Revoked, never-published, re-identified or re-sealed participants refuse.
func TestNativeConnectorJournalResumeReadsBackOneLiveParticipant(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r, err := NewConnectorJournal(f.store)
	if err != nil {
		t.Fatal(err)
	}
	p, err := r.PublishConnector(context.Background(), connectorInput(f))
	if err != nil {
		t.Fatal(err)
	}
	for i := range 300 {
		f.clock.ms.Add(time.Second.Milliseconds()) // time alone moves between reconnects
		input := connectorInput(f)
		input.Host.RuntimeID, input.TurnCorrelation = "runtime-next", "correlation-next"
		input.Admission.Policy.ExpiresAt = f.clock.Now().Add(time.Minute)
		out, err := r.ResumeConnector(context.Background(), input)
		if err != nil || out.OriginalPublished || out.Revision != p.Revision || !authority.SameParticipantCeiling(out.Participant, p.Participant) || !out.Participant.Grant.ExpiresAt.Equal(p.Participant.Grant.ExpiresAt) {
			t.Fatalf("resume %d: %+v %v", i, out, err)
		}
	}
	if status(t, f.store).Revision != p.Revision || len(f.store.current.Participants) != 1 {
		t.Fatal("resume wrote")
	}
	if err = predecessorAcceptsState(f.root, testBinding); err != nil {
		t.Fatal("predecessor refused", err)
	}
	for name, change := range map[string]func(*port.ConnectorLaunch){
		"identity":  func(v *port.ConnectorLaunch) { v.Admission.TaskEpoch++ },
		"authority": func(v *port.ConnectorLaunch) { v.Admission.AuthorityID = "other-authority" },
		"absent":    func(v *port.ConnectorLaunch) { v.Participant.ParticipantID = "never-published" },
		"ownership": func(v *port.ConnectorLaunch) { v.Participant.MutationOwnership = authority.TaskOwnership },
		"capability": func(v *port.ConnectorLaunch) {
			v.Admission.Policy.Capabilities = []authority.Capability{authority.List}
		},
		"approval": func(v *port.ConnectorLaunch) {
			v.Approval.Workspaces = append([]authority.ApprovedWorkspace(nil), v.Approval.Workspaces...)
			v.Approval.Workspaces[0].Root = "/other"
		},
		"profile": func(v *port.ConnectorLaunch) { v.Host.ProfileID = "different-profile" },
	} {
		input := connectorInput(f)
		change(&input)
		if out, err := r.ResumeConnector(context.Background(), input); err == nil || out.Participant.ParticipantID != "" {
			t.Fatal(name, "resumed", out)
		}
	}
	if err = r.WithdrawConnector(context.Background(), f.participant.ParticipantID); err != nil {
		t.Fatal(err)
	}
	revoked := status(t, f.store).Revision
	if out, err := r.ResumeConnector(context.Background(), connectorInput(f)); err == nil || out.Participant.ParticipantID != "" || status(t, f.store).Revision != revoked {
		t.Fatal("revoked participant resumed", out, err)
	}
	if err = predecessorAcceptsState(f.root, testBinding); err != nil {
		t.Fatal("predecessor refused", err)
	}
}

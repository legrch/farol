package access

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
// Since that commit the reader in state.go/disk.go changed only its bounds,
// and domain/authority is unchanged; so decodeState plus that commit's literal
// bounds (1 MiB file, 256 participants) is its exact reader. A refusal fails
// the predecessor's whole Store constructor.
func predecessorAcceptsState(root string, b Binding) error {
	info, err := os.Lstat(filepath.Join(root, stateName))
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() < 1 || info.Size() > 1024*1024 {
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

// laterReleaseSnapshot writes the canonical schema-1 snapshot a later release
// may produce once its write bound is lifted: the same encoding, more
// participants than this build writes. It replaces the closed Store's bytes.
func laterReleaseSnapshot(t *testing.T, f stateFixture, participants int) []byte {
	t.Helper()
	s := state{Revision: 9, Generation: f.approval.Generation, SeenApproval: true, Approval: &f.approval, Participants: map[string]retainedParticipant{}}
	for i := range participants {
		admission := f.admission
		admission.AuthorityID = fmt.Sprintf("authority-%d", i)
		g, err := authority.Derive(f.approval, admission, f.clock.Now())
		if err != nil {
			t.Fatal(err)
		}
		p, err := authority.Create(*g, authority.ParticipantAdmission{ParticipantID: fmt.Sprintf("participant-%d", i), Role: authority.Main, MutationOwnership: authority.NoOwnership})
		if err != nil {
			t.Fatal(err)
		}
		s.Participants[p.ParticipantID] = retainedParticipant{Value: *p, Revoked: i%2 == 0}
	}
	raw, err := json.Marshal(stateDocument(testBinding, s))
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	if err = os.WriteFile(filepath.Join(f.root, stateName), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return raw
}

// Step one of the two-step bound release: this build READS a snapshot with
// more than 256 participants, as the release after it may write. After such a
// rollback, revocation and other writes that do not grow the count keep
// working and stay canonical; an admission that would grow it is refused with
// the existing classified refusal and leaves the bytes untouched.
func TestNativeStoreAboveTheWriteBoundRevokesButNeverGrows(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	const participants = 300
	raw := laterReleaseSnapshot(t, f, participants)
	t.Logf("%d participants: %d bytes, %d bytes each", participants, len(raw), len(raw)/participants)
	store, err := Open(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal("larger snapshot refused", err)
	}
	if len(store.current.Participants) != participants || snapshot(t, store, "participant-299").Participant == nil || snapshot(t, store, "participant-298").Participant != nil {
		t.Fatal("larger snapshot misread")
	}
	_, err = store.Admit(context.Background(), status(t, store).Revision, f.admission, f.participant)
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	if after, err := os.ReadFile(filepath.Join(f.root, stateName)); err != nil || !bytes.Equal(after, raw) || status(t, store).Revision != 9 {
		t.Fatal("refused admission changed the snapshot", err)
	}
	if err = store.RevokeParticipant(context.Background(), status(t, store).Revision, "participant-299"); err != nil {
		t.Fatal("revocation blocked above the write bound", err)
	}
	if err = store.UpdateApproval(context.Background(), status(t, store).Revision, f.approval); err != nil {
		t.Fatal("approval renewal blocked above the write bound", err)
	}
	if err = store.RevokeApproval(context.Background(), status(t, store).Revision); err != nil {
		t.Fatal("approval revocation blocked above the write bound", err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal("rewritten snapshot refused", err)
	}
	t.Cleanup(func() { store.Close() })
	written, err := os.ReadFile(filepath.Join(f.root, stateName))
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := marshalDocument(stateDocument(testBinding, store.current))
	if err != nil || !bytes.Equal(canonical, written) || len(store.current.Participants) != participants || !store.current.Participants["participant-299"].Revoked || store.current.Approval != nil || status(t, store).Revision != 12 {
		t.Fatal("non-growing rewrite not durable or not canonical", err)
	}
}

// At the write bound, this build's own writes stay readable by 0.5.24 and the
// 257th participant is refused before publication.
func TestNativeStoreRefusesThe257thParticipant(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	laterReleaseSnapshot(t, f, maxParticipants)
	store, err := Open(f.root, testBinding, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err = store.RevokeParticipant(context.Background(), status(t, store).Revision, "participant-1"); err != nil {
		t.Fatal("write at the bound", err)
	}
	if err = predecessorAcceptsState(f.root, testBinding); err != nil {
		t.Fatal("predecessor refused this build's write", err)
	}
	written, err := os.ReadFile(filepath.Join(f.root, stateName))
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Admit(context.Background(), status(t, store).Revision, f.admission, f.participant)
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	if after, err := os.ReadFile(filepath.Join(f.root, stateName)); err != nil || !bytes.Equal(after, written) {
		t.Fatal("257th participant written", err)
	}
	if err = predecessorAcceptsState(f.root, testBinding); err != nil {
		t.Fatal("predecessor refused", err)
	}
}

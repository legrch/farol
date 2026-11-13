package boot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

// Real disposable access Store and ConnectorJournal behind the real connector
// owner; the endpoint, native workspace and Settings consent are fixtures. It
// proves durable participant growth only, not a host, socket or MCP client.
type participantConnectorFixture struct {
	root     string
	binding  accessrepo.Binding
	clock    *computerClockFixture
	store    *accessrepo.Store
	approval authority.Approval
	receipt  wire.ComputerAuthorityPublication
}

func newParticipantConnectorFixture(t *testing.T) *participantConnectorFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &participantConnectorFixture{root: filepath.Join(base, "computer"), binding: accessrepo.Binding{ProfileID: "profile", OwnerID: "owner", ComputerID: "computer"},
		clock: &computerClockFixture{now: time.UnixMilli(1900000000000)}}
	if err = os.Mkdir(f.root, 0700); err != nil {
		t.Fatal(err)
	}
	if f.store, err = accessrepo.Create(f.root, f.binding, f.clock); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	f.approval = authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3,
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/disposable", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}},
		Capabilities: []authority.Capability{authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: f.clock.Now().Add(authority.TaskGrantLifetime)}
	f.approve(t, f.approval)
	f.receipt = wire.ComputerAuthorityPublication{Fence: "1", StoreRevision: "1", SettingsRevision: "8", Generation: "3", ApprovalDigest: strings.Repeat("a", 64), PublishOperationId: "publication"}
	return f
}

func (f *participantConnectorFixture) approve(t *testing.T, a authority.Approval) {
	t.Helper()
	status, err := f.store.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err = f.store.UpdateApproval(context.Background(), status.Revision, a); err != nil {
		t.Fatal(err)
	}
	f.approval = a.Clone()
}

// connector starts one backend lifetime over the fixture's current Store.
func (f *participantConnectorFixture) connector(t *testing.T, backend string) (*computerConnector, *connectorEndpointFixture) {
	t.Helper()
	root := &ComputerIngress{store: f.store, native: &settingsNativeFixture{}, clock: f.clock, ownerID: "owner", computerID: "computer",
		peer: wire.Context{ProfileId: "profile", BackendGeneration: backend}, used: make(map[string]bool),
		publication: &knownComputerPublication{receipt: f.receipt, approval: f.approval.Clone()}}
	if _, err := root.guard.deactivate(); err != nil {
		t.Fatal(err)
	}
	journal, err := accessrepo.NewConnectorJournal(f.store)
	if err != nil {
		t.Fatal(err)
	}
	endpoint := &connectorEndpointFixture{}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s, err := newComputerConnector(ctx, root, journal, f.clock, func(_ context.Context, b wire.ComputerConnectorBinding, methods map[string]desktop.Method) (connectorEndpoint, error) {
		endpoint.value = wire.ComputerConnectorEndpoint{Binding: b, SocketPath: "/private/tmp/fixture.sock", Token: strings.Repeat("a", 64)}
		endpoint.methods = methods
		return endpoint, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, endpoint
}

func (f *participantConnectorFixture) open(generation string) wire.ComputerConnectorOpen {
	return wire.ComputerConnectorOpen{Publication: f.receipt, RuntimeId: "runtime", ConnectorGeneration: generation, LaunchDigest: strings.Repeat("b", 64)}
}

// participants reads the durable snapshot bytes: total and revoked records.
func (f *participantConnectorFixture) participants(t *testing.T) (total, revoked int) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.root, "computer-access.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Participants map[string]struct {
			Revoked bool `json:"revoked"`
		} `json:"participants"`
	}
	if err = json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, p := range doc.Participants {
		if p.Revoked {
			revoked++
		}
	}
	return len(doc.Participants), revoked
}

// cycle runs one ordinary Open/Close pair inside the recent-attempt window.
func participantCycle(t *testing.T, s *computerConnector, clock *computerClockFixture, in wire.ComputerConnectorOpen, label string) wire.ComputerConnectorExecution {
	t.Helper()
	clock.now = clock.now.Add(connectorOpenWindow / connectorOpenBurst)
	out, err := s.Open(context.Background(), "open-"+label, in)
	if err != nil {
		t.Fatalf("open %s: %v", label, err)
	}
	if _, err = s.Close(context.Background(), "close-"+label, wire.ComputerConnectorClose{Binding: out.Endpoint.Binding}); err != nil {
		t.Fatalf("close %s: %v", label, err)
	}
	return out.Execution
}

// More Open/Close cycles than the durable participant bound, all in one
// connector generation: every Open succeeds and the Store keeps one live
// participant. Each Open still gets its own turn correlation.
func TestComputerConnectorReconnectsReuseOneDurableParticipant(t *testing.T) {
	f := newParticipantConnectorFixture(t)
	s, endpoint := f.connector(t, "backend")
	const cycles = 300
	var first wire.ComputerConnectorExecution
	turns := map[string]bool{}
	for i := range cycles {
		e := participantCycle(t, s, f.clock, f.open("4"), fmt.Sprint(i))
		if i == 0 {
			first = e
		}
		if e.SessionId != first.SessionId || e.TaskId != first.TaskId || e.ParticipantId != first.ParticipantId || turns[e.TurnId] {
			t.Fatalf("cycle %d crossed identity or reused a turn: %+v", i, e)
		}
		turns[e.TurnId] = true
		if total, revoked := f.participants(t); total != 1 || revoked != 0 {
			t.Fatalf("cycle %d: participants=%d revoked=%d", i, total, revoked)
		}
	}
	if endpoint.closes != cycles {
		t.Fatal("endpoint closes", endpoint.closes)
	}
	// A clean backend shutdown still revokes the retained participant once.
	if err := s.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if total, revoked := f.participants(t); total != 1 || revoked != 1 {
		t.Fatalf("shutdown: participants=%d revoked=%d", total, revoked)
	}
}

// A different connector generation or Settings consent receipt is a new
// generation: the retained participant is revoked once, then a new one is
// admitted. A participant revoked meanwhile is never resumed, and an owner
// stop revokes instead of retaining.
func TestComputerConnectorNewGenerationRevokedOrStoppedGetsNewParticipant(t *testing.T) {
	for _, mode := range []string{"generation", "publication", "revoked", "owner-stop"} {
		t.Run(mode, func(t *testing.T) {
			f := newParticipantConnectorFixture(t)
			s, _ := f.connector(t, "backend")
			in := f.open("4")
			first := participantCycle(t, s, f.clock, in, "first")
			switch mode {
			case "generation":
				in = f.open("5")
			case "publication":
				// A new owner publication of the same approval policy.
				in.Publication.PublishOperationId = "publication-next"
				s.root.mu.Lock()
				s.root.publication.receipt = in.Publication
				s.root.mu.Unlock()
			case "revoked":
				journal, err := accessrepo.NewConnectorJournal(f.store)
				if err != nil {
					t.Fatal(err)
				}
				if err = journal.WithdrawConnector(context.Background(), first.ParticipantId); err != nil {
					t.Fatal(err)
				}
			case "owner-stop":
				out, err := s.Open(context.Background(), "open-stop", in)
				if err != nil || out.Execution.ParticipantId != first.ParticipantId {
					t.Fatal("same generation was not resumed", err)
				}
				reason := "owner_stop"
				if _, err = s.Close(context.Background(), "close-stop", wire.ComputerConnectorClose{Binding: out.Endpoint.Binding, Reason: &reason}); err != nil {
					t.Fatal(err)
				}
				if total, revoked := f.participants(t); total != 1 || revoked != 1 {
					t.Fatalf("owner stop retained: participants=%d revoked=%d", total, revoked)
				}
			}
			next := participantCycle(t, s, f.clock, in, "next")
			if next.ParticipantId == first.ParticipantId || next.SessionId == first.SessionId || next.TaskId == first.TaskId {
				t.Fatal("new generation inherited the participant identity")
			}
			if total, revoked := f.participants(t); total != 2 || revoked != 1 {
				t.Fatalf("participants=%d revoked=%d", total, revoked)
			}
			if again := participantCycle(t, s, f.clock, in, "again"); again.ParticipantId != next.ParticipantId {
				t.Fatal("new generation did not resume its own participant")
			}
			if total, _ := f.participants(t); total != 2 {
				t.Fatal("resume admitted", total)
			}
		})
	}
}

// A restart is a new backend lifetime. A clean shutdown revoked the previous
// lifetime's participant; the restarted backend reopens the Store, admits one
// new participant for the same connector generation and then resumes it.
func TestComputerConnectorRestartMidGenerationAdmitsOneNewParticipant(t *testing.T) {
	f := newParticipantConnectorFixture(t)
	s, _ := f.connector(t, "backend")
	in := f.open("4")
	first := participantCycle(t, s, f.clock, in, "before")
	if err := s.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	if f.store, err = accessrepo.Open(f.root, f.binding, f.clock); err != nil {
		t.Fatal("restart could not reopen the Store", err)
	}
	restarted, _ := f.connector(t, "backend-restarted")
	var after wire.ComputerConnectorExecution
	for i := range 3 {
		e := participantCycle(t, restarted, f.clock, in, fmt.Sprint("after-", i))
		if i == 0 {
			after = e
		}
		if e.ParticipantId == first.ParticipantId || e.ParticipantId != after.ParticipantId {
			t.Fatal("restart crossed participant identity")
		}
	}
	if total, revoked := f.participants(t); total != 2 || revoked != 1 {
		t.Fatalf("participants=%d revoked=%d", total, revoked)
	}
	if err = restarted.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if total, revoked := f.participants(t); total != 2 || revoked != 2 {
		t.Fatalf("participants=%d revoked=%d", total, revoked)
	}
}

// resumableJournalFixture adds the read-only resume capability to the injected
// journal and lets a revocation fail without acknowledgement.
type resumableJournalFixture struct {
	*connectorJournalFixture
	withdrawErr error
}

func (j *resumableJournalFixture) ResumeConnector(ctx context.Context, in port.ConnectorLaunch) (port.ConnectorPublication, error) {
	var out port.ConnectorPublication
	err := j.WithSnapshot(ctx, in.Participant.ParticipantID, func(v port.AccessSnapshot) error {
		if v.Participant == nil || v.Approval == nil {
			return errors.New("fixture participant not live")
		}
		out = port.ConnectorPublication{Revision: j.revision, Participant: v.Participant.Clone(), Approval: v.Approval.Clone()}
		return nil
	})
	return out, err
}
func (j *resumableJournalFixture) WithdrawConnector(ctx context.Context, id string) error {
	if j.withdrawErr != nil {
		j.withdrawals++
		return j.withdrawErr
	}
	return j.connectorJournalFixture.WithdrawConnector(ctx, id)
}

// An unacknowledged revocation of the retained participant at a generation
// change is never retried: that Open, every later Open and shutdown refuse.
func TestComputerConnectorUnknownRetainedRevocationNeverRetries(t *testing.T) {
	s, j, _, _, in := newConnectorFixture(t)
	r := &resumableJournalFixture{connectorJournalFixture: j}
	s.journal = r
	out, err := s.Open(context.Background(), "open", in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Close(context.Background(), "close", wire.ComputerConnectorClose{Binding: out.Endpoint.Binding}); err != nil || j.withdrawals != 0 || s.retained == nil {
		t.Fatal("clean close did not retain", err)
	}
	r.withdrawErr = errors.New("lost revocation reply")
	in.ConnectorGeneration = "9007199254740994"
	if _, err = s.Open(context.Background(), "next", in); err == nil || j.withdrawals != 1 || j.publications != 1 {
		t.Fatal("unknown revocation admitted a new participant", err)
	}
	if _, err = s.Open(context.Background(), "later", in); err == nil || j.withdrawals != 1 || j.publications != 1 {
		t.Fatal("unknown revocation retried or replaced", err)
	}
	if err = s.Shutdown(); err == nil || j.withdrawals != 1 {
		t.Fatal("shutdown replayed an unknown revocation", err)
	}
}

// The ingress claim set is a per-backend-lifetime record of consumed operation
// IDs and is never pruned; a durable operation-ID record is deferred. This pins
// the remaining bound so the deferred fix is visible: one reused-participant
// Open/Close cycle costs exactly two claims, ordinary claims stop at
// claimCapacity-claimWithdrawalReserve, and the reserve keeps the calls that
// REMOVE authority (connector Close, authority Deactivate) working after that.
func TestComputerConnectorClaimSetBoundKeepsWithdrawalWorking(t *testing.T) {
	if claimCapacity != 4096 || claimWithdrawalReserve != 64 {
		t.Fatal("claim bound moved; update this pin with the deferred durable record")
	}
	f := newParticipantConnectorFixture(t)
	s, _ := f.connector(t, "backend")
	in := f.open("4")
	participantCycle(t, s, f.clock, in, "warm")
	for i := range 3 {
		before := len(s.root.used)
		participantCycle(t, s, f.clock, in, fmt.Sprint("cycle-", i))
		if spent := len(s.root.used) - before; spent != 2 {
			t.Fatalf("one Open/Close cycle spent %d claims", spent)
		}
	}
	f.clock.now = f.clock.now.Add(connectorOpenWindow / connectorOpenBurst)
	out, err := s.Open(context.Background(), "open-before-full", in)
	if err != nil {
		t.Fatal(err)
	}
	// Exhaust the ordinary claims as a long backend lifetime would.
	for i := 0; len(s.root.used) < claimCapacity-claimWithdrawalReserve; i++ {
		if err = s.root.claim(fmt.Sprint("filler-", i)); err != nil {
			t.Fatal("ordinary claim refused below the bound", len(s.root.used), err)
		}
	}
	if err = s.root.claim("ordinary-over-bound"); err == nil {
		t.Fatal("ordinary claim entered the withdrawal reserve")
	}
	if _, err = s.Close(context.Background(), "close-when-full", wire.ComputerConnectorClose{Binding: out.Endpoint.Binding}); err != nil {
		t.Fatal("connector Close starved by the claim set", err)
	}
	if _, err = s.root.Deactivate(context.Background(), "deactivate-when-full"); err != nil {
		t.Fatal("authority Deactivate starved by the claim set", err)
	}
	f.clock.now = f.clock.now.Add(connectorOpenWindow)
	if _, err = s.Open(context.Background(), "open-when-full", in); err == nil {
		t.Fatal("Open used the withdrawal reserve")
	}
	for i := 0; len(s.root.used) < claimCapacity; i++ {
		if err = s.root.claimWithdrawal(fmt.Sprint("withdraw-", i)); err != nil {
			t.Fatal("withdrawal claim refused below capacity", len(s.root.used), err)
		}
	}
	if err = s.root.claimWithdrawal("withdraw-over-capacity"); err == nil {
		t.Fatal("claim set exceeded its lifetime capacity")
	}
}

// A resumed participant keeps the grant expiry of its first admission. Every
// connector operation, including discovery (catalogue) and process
// observation, reads its participant through an execution lease that reissues
// the expiry from the CURRENT approval, so a same-generation reconnect after
// that original expiry still works while the approval is renewed, and refuses
// once the approval itself has expired or been revoked.
func TestComputerConnectorResumedParticipantOutlivesItsFirstExpiry(t *testing.T) {
	for _, mode := range []string{"renewed", "expired", "revoked"} {
		t.Run(mode, func(t *testing.T) {
			f := newParticipantConnectorFixture(t)
			s, _ := f.connector(t, "backend")
			in := f.open("4")
			first := participantCycle(t, s, f.clock, in, "first")
			original := f.approval.ExpiresAt
			// Renew the same-generation consent (time only), as the Settings
			// renewal does, then move past the first participant's expiry.
			renewed := f.approval.Clone()
			f.clock.now = original.Add(-time.Minute)
			renewed.ExpiresAt = f.clock.now.Add(authority.TaskGrantLifetime)
			f.approve(t, renewed)
			s.root.mu.Lock()
			s.root.publication.currentApproval = &renewed
			s.root.mu.Unlock()
			f.clock.now = original.Add(time.Hour)
			out, err := s.Open(context.Background(), "open-after-expiry", in)
			if err != nil || out.Execution.ParticipantId != first.ParticipantId {
				t.Fatal("same generation did not resume", err)
			}
			if total, _ := f.participants(t); total != 1 {
				t.Fatal("resume admitted", total)
			}
			var stored time.Time
			if err = f.store.WithSnapshot(context.Background(), first.ParticipantId, func(v port.AccessSnapshot) error {
				stored = v.Participant.Grant.ExpiresAt
				return nil
			}); err != nil || !f.clock.now.After(stored) {
				t.Fatal("fixture did not pass the stored first expiry", stored, err)
			}
			switch mode {
			case "expired":
				f.clock.now = renewed.ExpiresAt.Add(time.Minute)
			case "revoked":
				status, err := f.store.Status(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if err = f.store.RevokeApproval(context.Background(), status.Revision); err != nil {
					t.Fatal(err)
				}
			}
			e := out.Execution
			catalogue := computerInvoke(t, s.current.route.Methods(s.root.peer)["computer.workspace.catalogue"],
				wire.ComputerCatalogueRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "catalogue"})
			// Process observation reads the same lease snapshot (observe.go).
			lease, leaseErr := s.current.route.admit(context.Background(), authority.List)
			var leased time.Time
			if leaseErr == nil {
				leaseErr = lease.WithSnapshot(context.Background(), e.ParticipantId, func(v port.AccessSnapshot) error {
					leased = v.Participant.Grant.ExpiresAt
					return nil
				})
			}
			if mode == "renewed" {
				if catalogue.Status != "ok" {
					t.Fatalf("discovery refused after the first expiry: %+v", catalogue)
				}
				if leaseErr != nil || !leased.After(f.clock.now) {
					t.Fatal("observation snapshot carries the stored expiry", leased, leaseErr)
				}
				return
			}
			if catalogue.Status == "ok" || leaseErr == nil {
				t.Fatal("expired or revoked approval still served", catalogue, leaseErr)
			}
		})
	}
}

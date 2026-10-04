package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// These fixtures contain no filesystem/process proof. They exercise storage
// reply failures, closed decoding and immutable-chain policy only.
type memoryDisk struct {
	records [][]byte
	fault   string
	fenced  bool
	calls   int
}

func (d *memoryDisk) read(_ context.Context, index int) ([]byte, bool, error) {
	if d.fenced {
		return nil, false, errors.New("unknown fence")
	}
	if index > len(d.records) {
		return nil, false, nil
	}
	return append([]byte{}, d.records[index-1]...), true, nil
}
func (d *memoryDisk) append(_ context.Context, index int, raw []byte) error {
	d.calls++
	if index != len(d.records)+1 {
		return errors.New("crossed index")
	}
	if d.fault == "partial" {
		d.records = append(d.records, []byte("{"))
		return errors.New("partial publication")
	}
	d.records = append(d.records, append([]byte{}, raw...))
	if d.fault == "lost" {
		return errors.New("lost publication reply")
	}
	return nil
}
func (d *memoryDisk) close() error  { return nil }
func (d *memoryDisk) poison() error { d.fenced = true; return nil }
func recordFixture() port.HandoffRecord {
	b := port.HandoffBinding{ProfileID: "profile", BackendGeneration: "generation-1", BuildID: "build", HostLifetimeID: "host-1", ChildLaunchID: "child-1", ParentRoot: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}, ChatRoot: port.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}}
	receipt := port.RetirementReceipt{Write: port.RetirementWrite{Scope: port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, Root: b.ChatRoot, Revision: 1, Turns: []port.RetirementTurn{}}, PublicationDigest: [32]byte{9}}
	return port.HandoffRecord{Version: 1, Stage: port.HandoffCaptured, Origin: port.HandoffLiveOwner, Publication: port.HandoffPublication{Binding: b, HandoffID: "handoff-1", ReceiptDigest: receipt.PublicationDigest}, Receipt: receipt}
}
func repoFixture(d *memoryDisk) *Repository {
	b := recordFixture().Publication.Binding
	return &Repository{owner: &owner{roots: Roots{ProfileID: b.ProfileID, Parent: Root{Identity: b.ParentRoot}, Chat: Root{Identity: b.ChatRoot}}, disk: d}}
}
func nextRecord(t *testing.T, r port.HandoffRecord) port.HandoffRecord {
	t.Helper()
	r = policy.Copy(r)
	switch r.Stage {
	case port.HandoffCaptured:
		r.Stage = port.HandoffAcknowledged
		r.ACK = &port.HandoffACK{Publication: r.Publication}
	case port.HandoffAcknowledged:
		raw, err := encode(r)
		d := sha256.Sum256(raw)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		r.Stage = port.HandoffTerminated
		r.Terminal = &port.HandoffTerminal{Publication: r.Publication, KnownACKDigest: d, Kind: port.HandoffNormalExit, StopMode: port.HandoffGracefulStop, ExitCode: &n}
	case port.HandoffTerminated:
		b := r.Publication.Binding
		b.BackendGeneration = "generation-2"
		b.HostLifetimeID = "host-2"
		b.ChildLaunchID = "child-2"
		r.Stage = port.HandoffConsumed
		r.Consumption = &port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, NextBinding: b, AttemptID: "attempt-2"}
	default:
		t.Fatal("unexpected fixture stage")
	}
	return r
}
func TestRepositoryComparePublishAndReplay(t *testing.T) {
	ctx := context.Background()
	d := &memoryDisk{}
	repo := repoFixture(d)
	r := recordFixture()
	head, err := repo.Load(ctx)
	if err != nil || head.Record != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		prior := head.Digest
		head, err = repo.Publish(ctx, prior, r)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = repo.Publish(ctx, prior, r); !errors.Is(err, Refused) {
			t.Fatal("replayed transition", err)
		}
		if i < 3 {
			r = nextRecord(t, r)
		}
	}
	if d.calls != 4 {
		t.Fatal("refused replay wrote bytes")
	}
	reopened := repoFixture(d)
	loaded, err := reopened.Load(ctx)
	if err != nil || loaded.Digest != head.Digest || loaded.Record.Stage != port.HandoffConsumed {
		t.Fatal("consumed fence lost", err)
	}
}

func cancelledRecordFixture() port.HandoffRecord {
	r := recordFixture()
	b := r.Publication.Binding
	fixed := port.TurnBinding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 1}
	i := turn.Identity{ProfileID: fixed.ProfileID, OwnerID: fixed.OwnerID, SessionID: fixed.SessionID, TaskID: fixed.TaskID, TurnID: fixed.TurnID, OperationID: fixed.OperationID, Generation: fixed.TurnGeneration}
	r.Receipt.Write.PreviousRevision, r.Receipt.Write.Revision = 3, 4
	r.Receipt.Write.Turns = []port.RetirementTurn{{Binding: fixed, AcknowledgedRevision: 3, Snapshot: turn.Snapshot{Identity: i, Phase: turn.Cancelled, HasResult: true, Result: turn.Result{ID: "result", Outcome: turn.CancelledOutcome, Code: "NOT_DISPATCHED"}, DeliveryAcknowledged: true, LifecycleSettled: true}}}
	return r
}

// Memory storage qualifies the persisted codec/chain, not native files or exit.
func TestRepositoryNeverDispatchedRoundtripAndReplay(t *testing.T) {
	ctx := context.Background()
	d := &memoryDisk{}
	repo := repoFixture(d)
	r := cancelledRecordFixture()
	original := port.CopyRetirement(r.Receipt.Write)
	head := &port.HandoffHead{}
	for step := 0; step < 4; step++ {
		previous := head.Digest
		var err error
		head, err = repo.Publish(ctx, previous, r)
		if err != nil {
			t.Fatal(err)
		}
		// Every stage is decoded in a fresh fixture repository; no live owner is restored.
		loaded, err := repoFixture(d).Load(ctx)
		if err != nil || loaded.Digest != head.Digest || !port.SameRetirement(loaded.Record.Receipt.Write, original) {
			t.Fatal("cancelled receipt changed in persisted chain", err)
		}
		if _, err := repo.Publish(ctx, previous, r); !errors.Is(err, Refused) {
			t.Fatal("cancelled transition replayed", err)
		}
		if step < 3 {
			r = nextRecord(t, r)
		}
	}
	if d.calls != 4 || head.Record.Stage != port.HandoffConsumed {
		t.Fatal("missing single consumption")
	}
}

func TestCodecNeverDispatchedRejectsUnsafePersistedProjection(t *testing.T) {
	r := cancelledRecordFixture()
	// Marshal bypasses encode's pre-publication policy to exercise decode itself.
	r.Receipt.Write.Turns[0].Snapshot.SendIntent = true
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decode(raw); err == nil {
		t.Fatal("unsafe persisted cancellation decoded")
	}
	d := &memoryDisk{records: [][]byte{raw}}
	if head, err := repoFixture(d).Load(context.Background()); head != nil || !errors.Is(err, Unknown) {
		t.Fatal("unsafe persisted cancellation minted known head", err)
	}
	if d.calls != 0 {
		t.Fatal("bad stored receipt was repaired")
	}
}
func TestRepositoryPublicationFailureFencesReopen(t *testing.T) {
	for _, fault := range []string{"partial", "lost"} {
		t.Run(fault, func(t *testing.T) {
			d := &memoryDisk{fault: fault}
			repo := repoFixture(d)
			if h, err := repo.Publish(context.Background(), [32]byte{}, recordFixture()); !errors.Is(err, Unknown) || h != nil {
				t.Fatal("unknown minted receipt", err)
			}
			if _, err := repo.Load(context.Background()); !errors.Is(err, Unknown) {
				t.Fatal("sticky failure lost", err)
			}
			if _, err := repoFixture(d).Load(context.Background()); !errors.Is(err, Unknown) {
				t.Fatal("unknown reopened", err)
			}
			if d.calls != 1 {
				t.Fatal("publication retried")
			}
		})
	}
}
func TestRepositoryRefusesCrossRootsAndBadChain(t *testing.T) {
	for _, name := range []string{"profile", "parent", "chat", "ACK-first", "missing-ACK", "malformed"} {
		t.Run(name, func(t *testing.T) {
			r := recordFixture()
			switch name {
			case "profile":
				r.Publication.Binding.ProfileID = "other"
				r.Receipt.Write.Scope.ProfileID = "other"
			case "parent":
				r.Publication.Binding.ParentRoot.Inode++
			case "chat":
				r.Publication.Binding.ChatRoot.Inode++
				r.Receipt.Write.Root.Inode++
			case "ACK-first":
				r = nextRecord(t, r)
			case "missing-ACK":
				r = nextRecord(t, nextRecord(t, r))
				r.ACK = nil
			}
			raw, err := encode(r)
			if name == "malformed" {
				raw = []byte("{")
			} else if err != nil {
				raw = []byte("null")
			}
			d := &memoryDisk{records: [][]byte{raw}}
			if h, err := repoFixture(d).Load(context.Background()); !errors.Is(err, Unknown) || h != nil {
				t.Fatal("bad persisted record accepted", err)
			}
		})
	}
}
func TestCodecRejectsNoncanonicalAndClosedUnknown(t *testing.T) {
	raw, err := encode(recordFixture())
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{nil, []byte("null"), append(append([]byte{}, raw...), byte(' ')), append(append([]byte{}, raw...), raw...), append([]byte(`{"Version":1,`), raw[1:]...), append([]byte(`{"Unknown":true,`), raw[1:]...), []byte(`{"Version":99}`), make([]byte, maxBytes+1), []byte{255}} {
		if _, err := decode(bad); err == nil {
			t.Fatal("noncanonical bytes accepted")
		}
	}
	got, err := decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := encode(got)
	digest := sha256.Sum256(canonical)
	if digest != sha256.Sum256(raw) {
		t.Fatal("canonical head mismatch")
	}
}
func TestRepositoryRejectsHistoricalGenerationAndAttemptReuse(t *testing.T) {
	r := recordFixture()
	history := []port.HandoffRecord{}
	for i := 0; i < 4; i++ {
		history = append(history, r)
		if i < 3 {
			r = nextRecord(t, r)
		}
	}
	n := recordFixture()
	n.Publication.Binding = r.Consumption.NextBinding
	n.Receipt.Write.Scope = r.Consumption.Next
	n.Publication.HandoffID = "handoff-2"
	if reused(history, n) {
		t.Fatal("fresh actual generation refused")
	}
	bad := policy.Copy(n)
	bad.Publication.HandoffID = "handoff-1"
	if !reused(history, bad) {
		t.Fatal("old handoff ID reused")
	}
	consumed := nextRecord(t, nextRecord(t, nextRecord(t, n)))
	consumed.Consumption.Next.BackendGeneration = "generation-1"
	consumed.Consumption.NextBinding.BackendGeneration = "generation-1"
	if !reused(history, consumed) {
		t.Fatal("old origin generation reused")
	}
}

func TestRepositoryRefusesHistoricalHostAndChildBeforeSuccessor(t *testing.T) {
	for _, identity := range []string{"host", "child"} {
		t.Run(identity, func(t *testing.T) {
			ctx := context.Background()
			disk := &memoryDisk{}
			repo := repoFixture(disk)
			var head *port.HandoffHead
			var err error
			r := recordFixture()
			head, _ = repo.Load(ctx)
			for step := 0; step < 4; step++ {
				head, err = repo.Publish(ctx, head.Digest, r)
				if err != nil {
					t.Fatal(err)
				}
				if step < 3 {
					r = nextRecord(t, r)
				}
			}
			successor := r.Consumption
			r = recordFixture()
			r.Publication.Binding = successor.NextBinding
			r.Publication.HandoffID = "handoff-2"
			r.Receipt.Write.Scope = successor.Next
			for step := 0; step < 3; step++ {
				head, err = repo.Publish(ctx, head.Digest, r)
				if err != nil {
					t.Fatal(err)
				}
				r = nextRecord(t, r)
			}
			r.Consumption.Next.BackendGeneration = "generation-3"
			r.Consumption.NextBinding.BackendGeneration = "generation-3"
			r.Consumption.NextBinding.HostLifetimeID = "host-3"
			r.Consumption.NextBinding.ChildLaunchID = "child-3"
			r.Consumption.AttemptID = "attempt-3"
			if identity == "host" {
				r.Consumption.NextBinding.HostLifetimeID = "host-1"
			} else {
				r.Consumption.NextBinding.ChildLaunchID = "child-1"
			}
			// Adjacent identities are distinct; the bounded historical chain must veto.
			if err := policy.ValidateRecord(r); err != nil {
				t.Fatal(err)
			}
			if got, err := repo.Publish(ctx, head.Digest, r); got != nil || !errors.Is(err, Refused) {
				t.Fatal("historical identity minted successor", err)
			}
			if disk.calls != 7 {
				t.Fatal("refused consumption appended", disk.calls)
			}
		})
	}
}

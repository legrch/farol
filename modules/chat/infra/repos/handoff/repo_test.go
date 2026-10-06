package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// These fixtures contain no filesystem/process proof. They exercise storage
// reply failures, closed decoding and immutable-chain policy only.
type memoryDisk struct {
	records     [][]byte
	fault       string
	fenced      bool
	calls       int
	afterAppend func()
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
	if d.afterAppend != nil {
		d.afterAppend()
	}
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
	for _, count := range []int{1, 8} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			r := cancelledRecordFixture()
			seed := r.Receipt.Write.Turns[0]
			r.Receipt.Write.Turns = nil
			for index := 0; index < count; index++ {
				v := seed
				v.Binding.OperationID = fmt.Sprintf("operation-%04d", index)
				v.Binding.TurnID = fmt.Sprintf("turn-%04d", index)
				v.Snapshot.Identity.OperationID = v.Binding.OperationID
				v.Snapshot.Identity.TurnID = v.Binding.TurnID
				v.AcknowledgedRevision = uint64(3 * (index + 1))
				r.Receipt.Write.Turns = append(r.Receipt.Write.Turns, v)
			}
			r.Receipt.Write.PreviousRevision = uint64(3 * count)
			r.Receipt.Write.Revision = r.Receipt.Write.PreviousRevision + 1
			repositoryRoundtrip(t, r, false)
		})
	}
}

func repositoryRoundtrip(t *testing.T, r port.HandoffRecord, maximalSuccessor bool) {
	t.Helper()
	ctx := context.Background()
	d := &memoryDisk{}
	repo := repoFixture(d)
	b := r.Publication.Binding
	repo.owner.roots = Roots{ProfileID: b.ProfileID, Parent: Root{Identity: b.ParentRoot}, Chat: Root{Identity: b.ChatRoot}}
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
		fresh := repoFixture(d)
		fresh.owner.roots = repo.owner.roots
		loaded, err := fresh.Load(ctx)
		if err != nil || loaded.Digest != head.Digest || !port.SameRetirement(loaded.Record.Receipt.Write, original) {
			t.Fatal("cancelled receipt changed in persisted chain", err)
		}
		if _, err := repo.Publish(ctx, previous, r); !errors.Is(err, Refused) {
			t.Fatal("cancelled transition replayed", err)
		}
		if step < 3 {
			r = nextRecord(t, r)
			if maximalSuccessor && r.Consumption != nil {
				c := r.Consumption
				c.Next.BackendGeneration = strings.Repeat("<", 119) + "n"
				c.NextBinding.BackendGeneration = c.Next.BackendGeneration
				c.NextBinding.HostLifetimeID = strings.Repeat("<", 119) + "h"
				c.NextBinding.ChildLaunchID = strings.Repeat("<", 119) + "c"
				c.AttemptID = strings.Repeat("<", 120)
			}
		}
	}
	if d.calls != 4 || head.Record.Stage != port.HandoffConsumed {
		t.Fatal("missing single consumption")
	}
}

// Max-length HTML-escaped IDs and numeric/digest bounds exercise late-stage
// metadata growth independently of the unchanged retirement payload. The
// terminal/drain remain explicit fixtures; this is no host/process witness.
func TestRepositoryRetirementBudgetReservesEveryLaterStage(t *testing.T) {
	r := cancelledRecordFixture()
	id := strings.Repeat("<", 120)
	b := &r.Publication.Binding
	b.ProfileID, b.BackendGeneration, b.BuildID, b.HostLifetimeID, b.ChildLaunchID = id, id, id, id, id
	b.ParentRoot = port.JournalRoot{Device: math.MaxUint64, Inode: math.MaxUint64 - 1, OwnerUID: math.MaxUint32}
	b.ChatRoot = port.JournalRoot{Device: math.MaxUint64, Inode: math.MaxUint64, OwnerUID: math.MaxUint32}
	r.Publication.HandoffID = id
	for index := range r.Publication.ReceiptDigest {
		r.Publication.ReceiptDigest[index] = 255
	}
	r.Receipt.PublicationDigest = r.Publication.ReceiptDigest
	w := &r.Receipt.Write
	w.Scope = port.JournalScope{ProfileID: id, BackendGeneration: id}
	w.Root = b.ChatRoot
	w.PreviousRevision, w.Revision = math.MaxUint64-2, math.MaxUint64-1
	seed := w.Turns[0]
	seed.Binding = port.TurnBinding{ProfileID: id, BackendGeneration: id, OwnerID: id, SessionID: id, TaskID: id, TaskEpoch: math.MaxUint64, ParticipantID: id, TurnID: id, OperationID: id, TurnGeneration: math.MaxUint64}
	seed.Snapshot.Identity = turn.Identity{ProfileID: id, OwnerID: id, SessionID: id, TaskID: id, TurnID: id, OperationID: id, Generation: math.MaxUint64}
	seed.Snapshot.Result.ID = id
	w.Turns = nil
	var oversized port.HandoffRecord
	for index := 0; index < turn.MaxRequests; index++ {
		v := seed
		unique := strings.Repeat("<", 116) + fmt.Sprintf("%04d", index)
		v.Binding.OperationID, v.Binding.TurnID = unique, unique
		v.Snapshot.Identity.OperationID, v.Snapshot.Identity.TurnID = unique, unique
		v.AcknowledgedRevision = math.MaxUint64 - 2 - uint64(index)
		w.Turns = append(w.Turns, v)
		raw, err := json.Marshal(*w)
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) > 1024*1024 {
			oversized = policy.Copy(r)
			w.Turns = w.Turns[:len(w.Turns)-1]
			break
		}
	}
	if oversized.Receipt.Write.Turns == nil {
		t.Fatal("fixture never reached retirement budget")
	}
	raw, err := json.Marshal(*w)
	if err != nil || len(raw) < 1024*1024-16384 {
		t.Fatal("fixture is not near retirement budget", len(raw), err)
	}
	repositoryRoundtrip(t, r, true)
	d := &memoryDisk{}
	repo := repoFixture(d)
	repo.owner.roots = Roots{ProfileID: b.ProfileID, Parent: Root{Identity: b.ParentRoot}, Chat: Root{Identity: b.ChatRoot}}
	if _, err := repo.Digest(oversized); !errors.Is(err, Invalid) {
		t.Fatal("oversize digest admitted", err)
	}
	if h, err := repo.Publish(context.Background(), [32]byte{}, oversized); h != nil || !errors.Is(err, Invalid) || d.calls != 0 {
		t.Fatal("oversize retirement published", err, d.calls)
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

func publishRetirementHead(t *testing.T, repo *Repository, record port.HandoffRecord) *port.HandoffHead {
	t.Helper()
	ctx := context.Background()
	head, err := repo.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for step := 0; step < 3; step++ {
		head, err = repo.Publish(ctx, head.Digest, record)
		if err != nil {
			t.Fatal(err)
		}
		if step < 2 {
			record = nextRecord(t, record)
		}
	}
	return head
}

func nextBuildRecord(t *testing.T, record port.HandoffRecord, generation int, build string) port.HandoffRecord {
	t.Helper()
	r := nextRecord(t, record)
	c := r.Consumption
	c.NextBinding = historyNextBinding(record.Publication.Binding, generation)
	c.NextBinding.BuildID = build
	c.Next.BackendGeneration, c.AttemptID = c.NextBinding.BackendGeneration, fmt.Sprintf("attempt-%d", generation)
	return r
}

func TestRepositoryCrossBuildEmptyChainReopenAndCAS(t *testing.T) {
	ctx := context.Background()
	d := &memoryDisk{}
	repo := repoFixture(d)
	r := recordFixture()
	for cycle := 1; cycle <= 2; cycle++ {
		head := publishRetirementHead(t, repo, r)
		if !head.EmptyRetirementChain {
			t.Fatal("empty prefix was not qualified")
		}
		before, calls := head.Digest, d.calls
		head.EmptyRetirementChain = false
		repo = repoFixture(d)
		head, err := repo.Load(ctx)
		if err != nil || !head.EmptyRetirementChain || head.Digest != before {
			t.Fatal("derived fact was lost or caller mutation escaped", err)
		}
		next := nextBuildRecord(t, *head.Record, cycle+1, fmt.Sprintf("build-%d", cycle+1))
		if got, err := repo.Publish(ctx, [32]byte{55}, next); got != nil || !errors.Is(err, Refused) || d.calls != calls || d.fenced {
			t.Fatal("cross-build stale CAS appended or fenced", err)
		}
		published, err := repo.Publish(ctx, before, next)
		if err != nil || !published.EmptyRetirementChain || published.Record.Publication != r.Publication || published.Record.Consumption.NextBinding != next.Consumption.NextBinding {
			t.Fatal("cross-build publication changed build provenance", err)
		}
		loaded, err := repoFixture(d).Load(ctx)
		if err != nil || loaded.Digest != published.Digest || !loaded.EmptyRetirementChain {
			t.Fatal("cross-build chain did not reopen", err)
		}
		r = historyRecord(next.Consumption.NextBinding, fmt.Sprintf("handoff-%d", cycle+1))
	}
	for _, raw := range d.records {
		if strings.Contains(string(raw), "EmptyRetirementChain") {
			t.Fatal("derived head fact changed persisted format")
		}
	}
}

func TestRepositoryCrossBuildRefusesNonemptyAncestorBeforeAppendAndOnRead(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancelled-%t", cancelled), func(t *testing.T) {
			ctx := context.Background()
			d := &memoryDisk{}
			original := historyRecord(recordFixture().Publication.Binding, "handoff-1", historyTurnSpec{"operation", "owner", cancelled})
			anchor := historyCycle(t, d, original, historyNextBinding(original.Publication.Binding, 2))
			repo := repoFixture(d)
			head := publishRetirementHead(t, repo, historyRecord(anchor.Consumption.NextBinding, "handoff-2"))
			if head.EmptyRetirementChain || len(head.Record.Receipt.Write.Turns) != 0 {
				t.Fatal("latest empty retirement hid ancestor")
			}
			next := nextBuildRecord(t, *head.Record, 3, "new-build")
			calls, count, digest := d.calls, len(d.records), head.Digest
			service, _ := policy.New(repo)
			if got, err := service.Consume(ctx, head.Record.Publication, *next.Consumption); got != nil || !errors.Is(err, policy.Refused) || d.calls != calls || d.fenced {
				t.Fatal("nonempty ancestor reached consume publication", err)
			}
			// Direct append has to enforce the same rule without the service.
			if got, err := repo.Publish(ctx, digest, next); got != nil || !errors.Is(err, Refused) || d.calls != calls || len(d.records) != count || d.fenced {
				t.Fatal("direct append bypassed ancestor refusal", err)
			}
			if got, err := repo.Load(ctx); err != nil || got.Digest != digest || got.EmptyRetirementChain {
				t.Fatal("known refusal changed retained head", err)
			}
			// A canonical individually valid record is not a valid retained chain.
			raw, err := encode(next)
			if err != nil {
				t.Fatal("record alone should be structurally valid", err)
			}
			d.records = append(d.records, raw)
			if got, err := repoFixture(d).Load(ctx); got != nil || !errors.Is(err, Unknown) || !d.fenced || d.calls != calls {
				t.Fatal("read accepted an incompatible persisted edge", err)
			}
		})
	}
}

func TestRepositoryCrossBuildPublicationUnknownStaysFenced(t *testing.T) {
	for _, fault := range []string{"partial", "lost", "late"} {
		t.Run(fault, func(t *testing.T) {
			d := &memoryDisk{}
			repo := repoFixture(d)
			head := publishRetirementHead(t, repo, recordFixture())
			next := nextBuildRecord(t, *head.Record, 2, "new-build")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			d.fault = fault
			if fault == "late" {
				d.afterAppend = cancel
			}
			if got, err := repo.Publish(ctx, head.Digest, next); got != nil || !errors.Is(err, Unknown) || !d.fenced {
				t.Fatal("uncertain cross-build publication admitted", err)
			}
			calls := d.calls
			d.fault, d.afterAppend = "", nil
			fresh := repoFixture(d)
			if got, err := fresh.Load(context.Background()); got != nil || !errors.Is(err, Unknown) {
				t.Fatal("new repository forgot unknown", err)
			}
			next.Consumption.NextBinding.BuildID = "another-build"
			if got, err := fresh.Publish(context.Background(), head.Digest, next); got != nil || !errors.Is(err, Unknown) || d.calls != calls {
				t.Fatal("new build retried unknown publication", err)
			}
		})
	}
}

package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// CPU-only chain fixtures: no filesystem, live origin, provider, child terminal,
// host-drain, current reader authority or actual successor-open qualification.
type historyTurnSpec struct {
	operation, owner string
	cancelled        bool
}

func historyRecord(b port.HandoffBinding, id string, specs ...historyTurnSpec) port.HandoffRecord {
	r := recordFixture()
	r.Publication.Binding, r.Publication.HandoffID = b, id
	r.Publication.ReceiptDigest = sha256.Sum256([]byte(id))
	r.Receipt.PublicationDigest = r.Publication.ReceiptDigest
	w := &r.Receipt.Write
	w.Scope = port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
	w.Root, w.PreviousRevision, w.Revision = b.ChatRoot, uint64(12*len(specs)), uint64(12*len(specs)+1)
	for index, spec := range specs {
		fixed := port.TurnBinding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration,
			OwnerID: spec.owner, SessionID: "session", TaskID: "task", TaskEpoch: 1,
			ParticipantID: "participant", TurnID: "turn-" + spec.operation, OperationID: spec.operation, TurnGeneration: 1}
		i := turn.Identity{ProfileID: fixed.ProfileID, OwnerID: fixed.OwnerID, SessionID: fixed.SessionID,
			TaskID: fixed.TaskID, TurnID: fixed.TurnID, OperationID: fixed.OperationID, Generation: fixed.TurnGeneration}
		v := port.RetirementTurn{Binding: fixed, AcknowledgedRevision: uint64(12*index + 10)}
		if spec.cancelled {
			v.Snapshot = turn.Snapshot{Identity: i, Phase: turn.Cancelled, HasResult: true,
				Result:               turn.Result{ID: spec.operation, Outcome: turn.CancelledOutcome, Code: "NOT_DISPATCHED"},
				DeliveryAcknowledged: true, LifecycleSettled: true}
		} else {
			slot := turn.Reservation{Identity: i, Ordinal: 1, Generation: 1, BackendGeneration: b.BackendGeneration}
			physical := turn.Binding{Reservation: slot, Document: turn.Document{ProviderState: turn.ProviderBound,
				ViewID: "view", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "conversation"}}
			v.Snapshot = turn.Snapshot{Identity: i, Phase: turn.Delivered, Reserved: true, Reservation: slot,
				Bound: true, Binding: physical, SendIntent: true, Accepted: true, DeltaCount: 1, LastSequence: 2,
				HasResult: true, Result: turn.Result{ID: spec.operation, Outcome: turn.Completed, Code: "PROVIDER_COMPLETED"},
				DeliveryAcknowledged: true, LifecycleSettled: true}
			v.SettledRevision, v.ReleasedRevision = v.AcknowledgedRevision+1, v.AcknowledgedRevision+2
			v.Quiescence = turn.QuiescenceEvidence{Binding: physical, ResultID: spec.operation, Sequence: 4, Confirmed: true}
			v.ResultPublication = port.ResultPublication{Version: 1, Root: b.ChatRoot,
				StorageRoot: port.JournalRoot{Device: b.ChatRoot.Device, Inode: b.ChatRoot.Inode + 1, OwnerUID: b.ChatRoot.OwnerUID},
				Digest:      sha256.Sum256([]byte(b.BackendGeneration + "/" + spec.operation)), EncodedBytes: 1024}
		}
		w.Turns = append(w.Turns, v)
	}
	return r
}

func historyNextBinding(b port.HandoffBinding, number int) port.HandoffBinding {
	b.BackendGeneration = fmt.Sprintf("generation-%d", number)
	b.HostLifetimeID = fmt.Sprintf("host-%d", number)
	b.ChildLaunchID = fmt.Sprintf("child-%d", number)
	return b
}

// Encode individual valid records directly, avoiding Publish's repeated scans
// when constructing large CPU-only chains. Lookup must still qualify the chain.
func historyCycle(t *testing.T, d *memoryDisk, r port.HandoffRecord, next port.HandoffBinding) port.HistoryAnchor {
	t.Helper()
	var digest [32]byte
	for step := 0; step < 4; step++ {
		raw, err := encode(r)
		if err != nil {
			t.Fatal("invalid history fixture", err)
		}
		d.records = append(d.records, raw)
		digest = sha256.Sum256(raw)
		if step < 3 {
			r = nextRecord(t, r)
			if r.Consumption != nil {
				r.Consumption.NextBinding = next
				r.Consumption.Next = port.JournalScope{ProfileID: next.ProfileID, BackendGeneration: next.BackendGeneration}
				r.Consumption.AttemptID = "attempt-" + next.BackendGeneration
			}
		}
	}
	return port.HistoryAnchor{HeadDigest: digest, Consumption: *r.Consumption}
}

func historyFixture(t *testing.T) (*Repository, *memoryDisk, port.HistoryAnchor, port.HandoffRecord) {
	t.Helper()
	d := &memoryDisk{}
	r := historyRecord(recordFixture().Publication.Binding, "history-1", historyTurnSpec{"operation", "owner", false})
	a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
	return repoFixture(d), d, a, r
}

func historyKey(v port.RetirementTurn) port.HistoryKey {
	return port.HistoryKey{BackendGeneration: v.Binding.BackendGeneration, OperationID: v.Binding.OperationID}
}

func TestHistoryCompletedAcrossEmptySuccessorRetirement(t *testing.T) {
	ctx := context.Background()
	repo, disk, anchorB, original := historyFixture(t)
	key := historyKey(original.Receipt.Write.Turns[0])
	check := func(a port.HistoryAnchor) {
		t.Helper()
		want := port.HistoryMatch{Anchor: a, Origin: original.Publication,
			PreviousRevision: original.Receipt.Write.PreviousRevision, Turn: original.Receipt.Write.Turns[0]}
		page, err := repo.HistoryPage(ctx, a, "owner", 0)
		if err != nil || page == nil || page.Anchor != a || page.Offset != 0 || page.Total != 1 ||
			!reflect.DeepEqual(page.Entries, []port.HistoryMatch{want}) {
			t.Fatal("exact original page lost", page, err)
		}
		match, err := repo.HistoryFind(ctx, a, "owner", key)
		if err != nil || match == nil || *match != want {
			t.Fatal("exact original match lost", match, err)
		}
		// Mutating every returned layer must not change any later read or source.
		page.Anchor.Consumption.AttemptID = "changed"
		page.Entries[0].Origin.Binding.HostLifetimeID = "changed"
		page.Entries[0].PreviousRevision++
		page.Entries[0].Turn.Snapshot.Binding.Document.ViewID = "changed"
		match.Anchor.Consumption.NextBinding.HostLifetimeID = "changed"
		match.Origin.ReceiptDigest[0]++
		match.Turn.ResultPublication.Digest[0]++
		again, err := repo.HistoryFind(ctx, a, "owner", key)
		if err != nil || again == nil || *again != want {
			t.Fatal("returned values alias storage", err)
		}
	}
	check(anchorB)
	emptyB := historyRecord(anchorB.Consumption.NextBinding, "history-2")
	anchorC := historyCycle(t, disk, emptyB, historyNextBinding(emptyB.Publication.Binding, 3))
	check(anchorC)
	head, err := repo.Load(ctx)
	if err != nil || head.Record.Receipt.Write.Turns == nil || len(head.Record.Receipt.Write.Turns) != 0 ||
		head.Record.Receipt.Write.PreviousRevision != 0 {
		t.Fatal("empty successor retirement copied historical turns", err)
	}
	if page, err := repo.HistoryPage(ctx, anchorB, "owner", 0); page != nil || !errors.Is(err, Refused) {
		t.Fatal("stale B anchor accepted after C", err)
	}
	if match, err := repo.HistoryFind(ctx, anchorB, "owner", key); match != nil || !errors.Is(err, Refused) {
		t.Fatal("stale find accepted", err)
	}
	if disk.calls != 0 || disk.fenced {
		t.Fatal("successful/refused history read wrote storage")
	}
}

// Fixed CPU authority and unreachable result IO qualify only catalogue behavior.
type compatibilityHistoryAuthority struct{ scope port.HistoryReadScope }

func (a compatibilityHistoryAuthority) AdmitHistoryRead(context.Context) (port.HistoryReadLease, error) {
	return a, nil
}
func (a compatibilityHistoryAuthority) WithCurrent(_ context.Context, inspect func(port.HistoryReadScope) error) error {
	return inspect(a.scope)
}

type compatibilityHistoryResults struct{}

func (compatibilityHistoryResults) Retain(context.Context, port.RetainRequest) (*port.RetainReceipt, error) {
	panic("catalogue cannot retain")
}
func (compatibilityHistoryResults) Read(context.Context, port.ResultRead) (*port.RetainRequest, error) {
	panic("empty history cannot read result bytes")
}
func (compatibilityHistoryResults) Fence(context.Context) error {
	panic("catalogue cannot fence results")
}

func TestHistoryCrossBuildEmptyPrefixPreservesLaterSameBuildHistory(t *testing.T) {
	ctx := context.Background()
	d := &memoryDisk{}
	repo := repoFixture(d)
	r := recordFixture()
	for cycle := 1; cycle <= 3; cycle++ {
		if cycle == 3 {
			r = historyRecord(r.Publication.Binding, r.Publication.HandoffID, historyTurnSpec{"completed", "owner", false})
		}
		head := publishRetirementHead(t, repo, r)
		build := fmt.Sprintf("build-%d", cycle+1)
		if cycle == 3 {
			build = r.Publication.Binding.BuildID
		}
		next := nextBuildRecord(t, *head.Record, cycle+1, build)
		service, _ := policy.New(repo)
		successor, err := service.Consume(ctx, r.Publication, *next.Consumption)
		if err != nil {
			t.Fatal(err)
		}
		reader, err := policy.NewHistoryReader(successor.History, policy.HistoryDependencies{
			Authority: compatibilityHistoryAuthority{port.HistoryReadScope{ProfileID: successor.Scope.ProfileID, BackendGeneration: successor.Scope.BackendGeneration, OwnerID: "owner"}},
			Results:   compatibilityHistoryResults{}, ResultBytesLimit: 8192,
		})
		if err != nil {
			t.Fatal(err)
		}
		calls, count := d.calls, len(d.records)
		page, err := reader.List(ctx, 0)
		if err != nil || page == nil || page.Entries == nil {
			t.Fatal("history became unavailable across empty build edge", err)
		}
		if cycle < 3 {
			if page.Total != 0 || len(page.Entries) != 0 {
				t.Fatal("empty chain fabricated history")
			}
			if got, err := reader.List(ctx, 1); got != nil || err == nil {
				t.Fatal("empty history accepted invalid offset")
			}
		} else if page.Total != 1 || len(page.Entries) != 1 || page.Entries[0].Key != historyKey(r.Receipt.Write.Turns[0]) || page.Entries[0].Binding != r.Receipt.Write.Turns[0].Binding {
			t.Fatal("empty ancestors hid later meaningful same-build history")
		}
		if got, err := reader.Read(ctx, port.HistoryKey{BackendGeneration: "generation-1", OperationID: "missing"}); got != nil || !errors.Is(err, policy.Refused) {
			t.Fatal("empty ancestor fabricated a result", err)
		}
		if d.calls != calls || len(d.records) != count || d.fenced {
			t.Fatal("history queries changed retirement state")
		}
		r = historyRecord(next.Consumption.NextBinding, fmt.Sprintf("handoff-%d", cycle+1))
	}
}

func TestHistoryPageStableOrderOwnerOffsetsAndMissingFind(t *testing.T) {
	ctx := context.Background()
	d := &memoryDisk{}
	b := recordFixture().Publication.Binding
	var want []port.HistoryMatch
	for cycle := 1; cycle <= 2; cycle++ {
		var specs []historyTurnSpec
		for index := 0; index < 70; index++ {
			owner := "owner"
			if index%3 == 0 {
				owner = "other"
			}
			// Later chain operations sort before the earlier cycle's operations.
			specs = append(specs, historyTurnSpec{fmt.Sprintf("%d-op-%03d", 3-cycle, index), owner, index%7 == 0})
		}
		r := historyRecord(b, fmt.Sprintf("history-%d", cycle), specs...)
		a := historyCycle(t, d, r, historyNextBinding(b, cycle+1))
		for _, v := range r.Receipt.Write.Turns {
			if v.Binding.OwnerID == "owner" && v.Snapshot.Result.Outcome == turn.Completed {
				want = append(want, port.HistoryMatch{Origin: r.Publication, PreviousRevision: r.Receipt.Write.PreviousRevision, Turn: v})
			}
		}
		b = a.Consumption.NextBinding
	}
	head, err := repoFixture(d).Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	a := port.HistoryAnchor{HeadDigest: head.Digest, Consumption: *head.Record.Consumption}
	for index := range want {
		want[index].Anchor = a
	}
	repo := repoFixture(d)
	for _, offset := range []uint32{0, 1, 31, 32, 64, uint32(len(want) - 1), uint32(len(want))} {
		page, err := repo.HistoryPage(ctx, a, "owner", offset)
		end := min(int(offset)+port.HistoryPageSize, len(want))
		if err != nil || page == nil || page.Anchor != a || page.Offset != offset || page.Total != uint32(len(want)) ||
			page.Entries == nil || !reflect.DeepEqual(page.Entries, append([]port.HistoryMatch{}, want[offset:end]...)) {
			t.Fatal("owner offset or immutable order changed", offset, page, err)
		}
	}
	for _, offset := range []uint32{uint32(len(want) + 1), port.MaxRetainedResults, math.MaxUint32} {
		if page, err := repo.HistoryPage(ctx, a, "owner", offset); page != nil || !errors.Is(err, Refused) {
			t.Fatal("out-of-range page exposed", offset, err)
		}
	}
	for _, m := range want {
		got, err := repo.HistoryFind(ctx, a, "owner", historyKey(m.Turn))
		if err != nil || got == nil || *got != m {
			t.Fatal("page/find disagree", err)
		}
	}
	for _, key := range []port.HistoryKey{{BackendGeneration: "missing-generation", OperationID: "missing"}, {BackendGeneration: b.BackendGeneration, OperationID: "missing"}, historyKey(want[0].Turn)} {
		owner := "owner"
		if key == historyKey(want[0].Turn) {
			owner = "other"
		}
		if got, err := repo.HistoryFind(ctx, a, owner, key); got != nil || err != nil {
			t.Fatal("missing/wrong-owner find leaked", got, err)
		}
	}
	page, err := repo.HistoryPage(ctx, a, "absent-owner", 0)
	if err != nil || page == nil || page.Total != 0 || page.Entries == nil || len(page.Entries) != 0 {
		t.Fatal("empty owner page", err)
	}
	if d.calls != 0 || d.fenced {
		t.Fatal("successful or missing read wrote storage")
	}
}

// Instrumentation wraps the existing memoryDisk without touching native IO.
type historyReadDisk struct {
	*memoryDisk
	reads int
	at    func(context.Context, int) error
}

func (d *historyReadDisk) read(ctx context.Context, index int) ([]byte, bool, error) {
	d.reads++
	if d.at != nil {
		if err := d.at(ctx, index); err != nil {
			return nil, false, err
		}
	}
	return d.memoryDisk.read(ctx, index)
}

func TestHistoryInvalidInputsFailBeforeIO(t *testing.T) {
	_, disk, good, original := historyFixture(t)
	key := historyKey(original.Receipt.Write.Turns[0])
	for name, mutate := range map[string]func(*port.HistoryAnchor){
		"digest":     func(a *port.HistoryAnchor) { a.HeadDigest = [32]byte{} },
		"drain":      func(a *port.HistoryAnchor) { a.Consumption.PreviousHostDrainConfirmed = false },
		"attempt":    func(a *port.HistoryAnchor) { a.Consumption.AttemptID = "" },
		"scope":      func(a *port.HistoryAnchor) { a.Consumption.Next.ProfileID = "different" },
		"generation": func(a *port.HistoryAnchor) { a.Consumption.Next.BackendGeneration = "different" },
		"root":       func(a *port.HistoryAnchor) { a.Consumption.NextBinding.ChatRoot.Device = 0 },
		"same-root":  func(a *port.HistoryAnchor) { a.Consumption.NextBinding.ChatRoot = a.Consumption.NextBinding.ParentRoot },
		"build":      func(a *port.HistoryAnchor) { a.Consumption.NextBinding.BuildID = "" },
		"host":       func(a *port.HistoryAnchor) { a.Consumption.NextBinding.HostLifetimeID = "invalid host" },
		"child":      func(a *port.HistoryAnchor) { a.Consumption.NextBinding.ChildLaunchID = strings.Repeat("x", 121) },
		"uid":        func(a *port.HistoryAnchor) { a.Consumption.NextBinding.ChatRoot.OwnerUID++ },
	} {
		t.Run(name, func(t *testing.T) {
			d := &historyReadDisk{memoryDisk: disk}
			repo := repoFixture(disk)
			repo.owner.disk = d
			a := good
			mutate(&a)
			if page, err := repo.HistoryPage(context.Background(), a, "owner", 0); page != nil || !errors.Is(err, Invalid) {
				t.Fatal("malformed anchor page", err)
			}
			if match, err := repo.HistoryFind(context.Background(), a, "owner", key); match != nil || !errors.Is(err, Invalid) {
				t.Fatal("malformed anchor find", err)
			}
			if d.reads != 0 || d.calls != 0 || d.fenced {
				t.Fatal("invalid input performed IO")
			}
		})
	}
	for _, id := range []string{"", "bad id", "bad\t", "bad\x7f", string([]byte{255}), strings.Repeat("x", 121)} {
		d := &historyReadDisk{memoryDisk: disk}
		repo := repoFixture(disk)
		repo.owner.disk = d
		if page, err := repo.HistoryPage(context.Background(), good, id, 0); page != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid owner page", err)
		}
		if match, err := repo.HistoryFind(context.Background(), good, id, key); match != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid owner find", err)
		}
		for _, badKey := range []port.HistoryKey{{BackendGeneration: id, OperationID: key.OperationID}, {BackendGeneration: key.BackendGeneration, OperationID: id}} {
			if match, err := repo.HistoryFind(context.Background(), good, "owner", badKey); match != nil || !errors.Is(err, Invalid) {
				t.Fatal("invalid key", err)
			}
		}
		if d.reads != 0 {
			t.Fatal("invalid identifiers performed IO")
		}
	}
	for _, repo := range []*Repository{nil, {}} {
		if got, err := repo.HistoryPage(context.Background(), good, "owner", 0); got != nil || !errors.Is(err, Invalid) {
			t.Fatal("nil repository accepted", err)
		}
		if got, err := repo.HistoryFind(context.Background(), good, "owner", key); got != nil || !errors.Is(err, Invalid) {
			t.Fatal("nil repository find accepted", err)
		}
	}
	repo := repoFixture(disk)
	if got, err := repo.HistoryPage(nil, good, "owner", 0); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("nil context", err)
	}
	if got, err := repo.HistoryFind(nil, good, "owner", key); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("nil find context", err)
	}
}

func TestHistoryCrossedAnchorAndUnconsumedHeadRefused(t *testing.T) {
	for _, name := range []string{"digest", "consumption", "profile", "roots", "empty", "captured", "acknowledged", "terminated"} {
		t.Run(name, func(t *testing.T) {
			repo, d, a, r := historyFixture(t)
			switch name {
			case "digest":
				a.HeadDigest[0]++
			case "consumption":
				a.Consumption.AttemptID = "other-valid-attempt"
			case "profile":
				a.Consumption.Next.ProfileID, a.Consumption.NextBinding.ProfileID = "other", "other"
			case "roots":
				a.Consumption.NextBinding.ChatRoot.Inode += 100
			case "empty":
				d.records = nil
			case "captured", "acknowledged", "terminated":
				steps := map[string]int{"captured": 1, "acknowledged": 2, "terminated": 3}[name]
				d.records = d.records[:steps]
				a.HeadDigest = sha256.Sum256(d.records[steps-1])
			}
			if got, err := repo.HistoryPage(context.Background(), a, "owner", 0); got != nil || !errors.Is(err, Refused) {
				t.Fatal("unqualified anchor page", err)
			}
			if got, err := repo.HistoryFind(context.Background(), a, "owner", historyKey(r.Receipt.Write.Turns[0])); got != nil || !errors.Is(err, Refused) {
				t.Fatal("unqualified anchor find", err)
			}
			if d.calls != 0 || d.fenced {
				t.Fatal("anchor refusal wrote storage")
			}
		})
	}
}

func TestHistoryWholeChainCorruptionNeverExposesEarlierMatch(t *testing.T) {
	for _, lookup := range []string{"page", "find", "missing", "other-owner"} {
		for _, fault := range []string{"prefix", "suffix", "partial", "unknown-field", "bad-terminal", "cross-root", "reuse", "gap-read", "unknown-read", "late-read", "late-end", "ambiguous-key", "unsafe-completed", "unsafe-cancelled"} {
			t.Run(lookup+"/"+fault, func(t *testing.T) {
				repo, disk, a, original := historyFixture(t)
				empty := historyRecord(a.Consumption.NextBinding, "history-2")
				a = historyCycle(t, disk, empty, historyNextBinding(empty.Publication.Binding, 3))
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				d := &historyReadDisk{memoryDisk: disk}
				repo.owner.disk = d
				mutateRaw := func(index int, mutate func(*port.HandoffRecord)) {
					r, err := decode(disk.records[index])
					if err != nil {
						t.Fatal(err)
					}
					mutate(&r)
					raw, err := json.Marshal(r) // Intentionally bypass hostile-record validation.
					if err != nil {
						t.Fatal(err)
					}
					disk.records[index] = raw
				}
				switch fault {
				case "prefix":
					disk.records[0] = []byte("{")
				case "suffix":
					disk.records[7] = []byte("{")
				case "partial":
					disk.records = append(disk.records, []byte("{"))
				case "unknown-field":
					disk.records[7] = append([]byte(`{"Unknown":true,`), disk.records[7][1:]...)
				case "bad-terminal":
					mutateRaw(6, func(r *port.HandoffRecord) { r.Terminal.KnownACKDigest[0]++ })
				case "cross-root":
					mutateRaw(7, func(r *port.HandoffRecord) { r.Publication.Binding.ChatRoot.Inode++ })
				case "reuse":
					mutateRaw(7, func(r *port.HandoffRecord) {
						r.Consumption.NextBinding.HostLifetimeID = original.Publication.Binding.HostLifetimeID
					})
				case "gap-read", "unknown-read":
					d.at = func(_ context.Context, index int) error {
						if index == 9 {
							return errors.New("inventory/commit uncertainty fixture")
						}
						return nil
					}
				case "late-read", "late-end":
					lateIndex := 8
					if fault == "late-end" {
						lateIndex = 9
					}
					d.at = func(_ context.Context, index int) error {
						if index == lateIndex {
							cancel()
						}
						return nil
					}
				case "ambiguous-key":
					mutateRaw(3, func(r *port.HandoffRecord) {
						r.Receipt.Write = port.CopyRetirement(original.Receipt.Write)
						r.Receipt.Write.Turns = append(r.Receipt.Write.Turns, r.Receipt.Write.Turns[0])
					})
				case "unsafe-completed":
					mutateRaw(3, func(r *port.HandoffRecord) { r.Receipt.Write.Turns[0].ReleasedRevision = 0 })
				case "unsafe-cancelled":
					mutateRaw(7, func(r *port.HandoffRecord) {
						r.Receipt.Write = cancelledRecordFixture().Receipt.Write
						r.Receipt.Write.Scope.BackendGeneration = r.Publication.Binding.BackendGeneration
						r.Receipt.Write.Turns[0].Binding.BackendGeneration = r.Publication.Binding.BackendGeneration
						r.Receipt.Write.Turns[0].Snapshot.SendIntent = true
					})
				}
				key, ownerID := historyKey(original.Receipt.Write.Turns[0]), "owner"
				if lookup == "missing" {
					key.OperationID = "missing"
				} else if lookup == "other-owner" {
					ownerID = "other-owner"
				}
				if lookup == "page" {
					if got, err := repo.HistoryPage(ctx, a, ownerID, 0); got != nil || !errors.Is(err, Unknown) {
						t.Fatal("corrupt chain exposed page", got, err)
					}
				} else if got, err := repo.HistoryFind(ctx, a, ownerID, key); got != nil || !errors.Is(err, Unknown) {
					t.Fatal("corrupt suffix exposed match/missing", got, err)
				}
				if !disk.fenced || !repo.owner.poisoned || disk.calls != 0 {
					t.Fatal("unknown read lost existing sticky fence")
				}
				if got, err := repoFixture(disk).HistoryFind(context.Background(), a, "owner", key); got != nil || !errors.Is(err, Unknown) {
					t.Fatal("unknown read reopened", err)
				}
			})
		}
	}
}

func TestHistoryGlobalCompletedBoundAcrossOwners(t *testing.T) {
	for _, overflow := range []bool{false, true} {
		t.Run(fmt.Sprint(overflow), func(t *testing.T) {
			d := &memoryDisk{}
			b := recordFixture().Publication.Binding
			var a port.HistoryAnchor
			for cycle := 1; cycle <= 4; cycle++ {
				var specs []historyTurnSpec
				for index := 0; index < port.MaxRetainedResults/4; index++ {
					ownerID := "other-owner"
					if index == 0 && cycle == 1 {
						ownerID = "owner"
					}
					specs = append(specs, historyTurnSpec{fmt.Sprintf("operation-%04d", index), ownerID, false})
				}
				r := historyRecord(b, fmt.Sprintf("history-%d", cycle), specs...)
				a = historyCycle(t, d, r, historyNextBinding(b, cycle+1))
				b = a.Consumption.NextBinding
			}
			if overflow {
				r := historyRecord(b, "history-5", historyTurnSpec{"overflow-other-owner", "other-owner", false})
				a = historyCycle(t, d, r, historyNextBinding(b, 6))
			}
			repo := repoFixture(d)
			key := port.HistoryKey{BackendGeneration: "generation-1", OperationID: "operation-0000"}
			if overflow {
				if got, err := repo.HistoryPage(context.Background(), a, "owner", 0); got != nil || !errors.Is(err, Unknown) {
					t.Fatal("global overflow silently truncated page", err)
				}
				// Fresh in-memory owner, same overflowing bytes, without fixture fence.
				d.fenced = false
				if got, err := repoFixture(d).HistoryFind(context.Background(), a, "owner", key); got != nil || !errors.Is(err, Unknown) {
					t.Fatal("early find skipped other-owner capacity", err)
				}
			} else {
				got, err := repo.HistoryPage(context.Background(), a, "owner", 0)
				if err != nil || got == nil || got.Total != 1 || len(got.Entries) != 1 {
					t.Fatal("exact global bound refused", err)
				}
				match, err := repo.HistoryFind(context.Background(), a, "owner", key)
				if err != nil || match == nil || match.Turn != got.Entries[0].Turn {
					t.Fatal("exact-bound find lost", err)
				}
				if d.fenced {
					t.Fatal("bounded read fenced storage")
				}
			}
			if d.calls != 0 {
				t.Fatal("capacity lookup appended storage")
			}
		})
	}
}

func TestHistoryCancelledClosedAndUnknownBeforeRead(t *testing.T) {
	for _, lookup := range []string{"page", "find"} {
		for _, state := range []string{"cancelled", "closed", "unknown", "cancelled-waiting"} {
			t.Run(lookup+"/"+state, func(t *testing.T) {
				repo, disk, a, original := historyFixture(t)
				d := &historyReadDisk{memoryDisk: disk}
				repo.owner.disk = d
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				want := Cancelled
				switch state {
				case "cancelled":
					cancel()
				case "closed":
					if err := repo.Close(); err != nil {
						t.Fatal(err)
					}
					want = Unavailable
				case "unknown":
					if err := repo.Fence(ctx); err != nil {
						t.Fatal(err)
					}
					want = Unknown
				}
				read := func() error {
					if lookup == "page" {
						got, err := repo.HistoryPage(ctx, a, "owner", 0)
						if got != nil {
							t.Error("pre-read failure exposed page")
						}
						return err
					}
					got, err := repo.HistoryFind(ctx, a, "owner", historyKey(original.Receipt.Write.Turns[0]))
					if got != nil {
						t.Error("pre-read failure exposed match")
					}
					return err
				}
				var err error
				if state == "cancelled-waiting" {
					repo.owner.mu.Lock()
					done := make(chan error, 1)
					go func() { done <- read() }()
					cancel()
					repo.owner.mu.Unlock()
					err = <-done
				} else {
					err = read()
				}
				if !errors.Is(err, want) || d.reads != 0 || d.calls != 0 {
					t.Fatal("pre-read fence ignored", err, d.reads)
				}
				if state != "unknown" && disk.fenced {
					t.Fatal("known cancellation/closure wrote uncertainty")
				}
			})
		}
	}
}

func TestHistoryChainStepBound(t *testing.T) {
	d := &memoryDisk{}
	b := recordFixture().Publication.Binding
	var a port.HistoryAnchor
	for cycle := 1; cycle <= maxSteps/4; cycle++ {
		a = historyCycle(t, d, historyRecord(b, fmt.Sprintf("history-%d", cycle)), historyNextBinding(b, cycle+1))
		b = a.Consumption.NextBinding
	}
	page, err := repoFixture(d).HistoryPage(context.Background(), a, "owner", 0)
	if err != nil || page == nil || page.Total != 0 || page.Entries == nil {
		t.Fatal("exact step bound refused", err)
	}
	d.records = append(d.records, []byte("unbounded-suffix"))
	if got, err := repoFixture(d).HistoryFind(context.Background(), a, "owner", port.HistoryKey{BackendGeneration: "generation-1", OperationID: "missing"}); got != nil || !errors.Is(err, Unknown) {
		t.Fatal("scan step bound ignored", err)
	}
}

func TestHistoryValidIDBoundsAndNeverDispatchedExcluded(t *testing.T) {
	d := &memoryDisk{}
	b := recordFixture().Publication.Binding
	ownerID := strings.Repeat("界", 40) // 120 UTF-8 bytes, valid owner boundary.
	r := historyRecord(b, "history-1", historyTurnSpec{"completed", ownerID, false}, historyTurnSpec{"never-dispatched", ownerID, true})
	a := historyCycle(t, d, r, historyNextBinding(b, 2))
	page, err := repoFixture(d).HistoryPage(context.Background(), a, ownerID, 0)
	if err != nil || page == nil || page.Total != 1 || len(page.Entries) != 1 {
		t.Fatal("mixed receipt or maximal owner refused", err)
	}
	if got, err := repoFixture(d).HistoryFind(context.Background(), a, ownerID, historyKey(r.Receipt.Write.Turns[1])); got != nil || err != nil {
		t.Fatal("never-dispatched turn became history", err)
	}
	if err := policy.ValidateRecord(r); err != nil {
		t.Fatal("fixture weakened closed policy", err)
	}
}

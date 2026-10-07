package handoff

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// CPU-only fixtures exercise the shared full-chain scanner and the exact ACK
// predicate. They establish no native lock, inode, directory or runtime proof.
func acknowledgedInspectionPureFixture(t *testing.T) (*memoryDisk, Roots, port.HandoffRecord) {
	t.Helper()
	d := &memoryDisk{}
	r := recordFixture()
	for step := 0; step < 2; step++ {
		raw, err := encode(r)
		if err != nil {
			t.Fatal(err)
		}
		d.records = append(d.records, raw)
		if step == 0 {
			r = nextRecord(t, r)
		}
	}
	return d, repoFixture(d).owner.roots, r
}

func TestAcknowledgedInspectionPureExactPrefixAndCopy(t *testing.T) {
	d, roots, ack := acknowledgedInspectionPureFixture(t)
	chain, err := closedInspectionEmptyChainScan(context.Background(), roots, d.read)
	if err != nil || acknowledgedInspectionQualify(chain, ack.Publication.Binding, ack.Publication.HandoffID) != nil {
		t.Fatal("exact initial ACK prefix refused", err)
	}
	if !chain.head.EmptyRetirementChain || chain.head.Digest != sha256.Sum256(d.records[1]) || !reflect.DeepEqual(*chain.head.Record, ack) || len(chain.stages) != 2 {
		t.Fatal("canonical head differs")
	}
	for i, raw := range d.records {
		r, err := decode(raw)
		if err != nil || chain.stages[i] != (ClosedInspectionStage{Index: i + 1, Stage: r.Stage, Digest: sha256.Sum256(raw)}) {
			t.Fatal("canonical prefix digest differs", err)
		}
	}
	l := &AcknowledgedLease{head: chain.head, verify: func() error { return nil }, close: func() error { return nil }}
	v := l.Observation()
	v.Digest[0]++
	v.EmptyRetirementChain = false
	v.Record.Publication.HandoffID = "changed"
	v.Record.ACK.Publication.Binding.ChildLaunchID = "changed"
	v.Record.Receipt.Write.Turns = append(v.Record.Receipt.Write.Turns, port.RetirementTurn{})
	if got := l.Observation(); !reflect.DeepEqual(got, chain.head) || got == chain.head || got.Record == chain.head.Record || got.Record.ACK == chain.head.Record.ACK {
		t.Fatal("diagnostic aliases retained head")
	}
	if err := l.Verify(); err != nil || d.fenced || d.calls != 0 {
		t.Fatal("observation mutated storage", err)
	}
	if _, err := closedInspectionScan(context.Background(), roots, port.JournalScope{ProfileID: roots.ProfileID, BackendGeneration: "generation-2"}, d.read); !errors.Is(err, Refused) {
		t.Fatal("ACK broadened consumed-only inspection", err)
	}
}

func TestAcknowledgedInspectionPureRefusalsNeverPoison(t *testing.T) {
	for _, kind := range []string{"empty", "captured", "terminal", "consumed", "extra-cycle", "ack-only", "gap", "malformed", "noncanonical", "unknown-field", "trailing-invalid", "terminal-field", "consumption-field", "nonempty", "unknown", "read-failure"} {
		t.Run(kind, func(t *testing.T) {
			d, roots, ack := acknowledgedInspectionPureFixture(t)
			switch kind {
			case "empty":
				d.records = nil
			case "captured":
				d.records = d.records[:1]
			case "terminal", "consumed", "extra-cycle":
				r := nextRecord(t, ack)
				for {
					raw, err := encode(r)
					if err != nil {
						t.Fatal(err)
					}
					d.records = append(d.records, raw)
					if kind == "terminal" || r.Stage == port.HandoffConsumed {
						break
					}
					r = nextRecord(t, r)
				}
				if kind == "extra-cycle" {
					r = historyRecord(r.Consumption.NextBinding, "handoff-2")
					for step := 0; step < 2; step++ {
						raw, err := encode(r)
						if err != nil {
							t.Fatal(err)
						}
						d.records = append(d.records, raw)
						r = nextRecord(t, r)
					}
					// Even an ACK head after a completely empty consumed ancestor
					// cannot qualify as the initial two-step prefix.
					ack.Publication = r.Publication
				}
			case "ack-only":
				d.records = d.records[1:]
			case "gap":
				d.records = append(d.records[:1], d.records[0])
			case "malformed":
				d.records[0] = []byte("{}")
			case "noncanonical":
				d.records[0] = append(d.records[0], ' ')
			case "unknown-field":
				d.records[1] = append(append([]byte{}, d.records[1][:len(d.records[1])-1]...), []byte(`,"Unknown":true}`)...)
			case "trailing-invalid":
				d.records = append(d.records, []byte("{}"))
			case "terminal-field":
				terminal := nextRecord(t, ack)
				raw, err := encode(terminal)
				if err != nil {
					t.Fatal(err)
				}
				d.records[1] = []byte(strings.Replace(string(raw), string(port.HandoffTerminated), string(port.HandoffAcknowledged), 1))
			case "consumption-field":
				consumed := nextRecord(t, nextRecord(t, ack))
				raw, err := encode(consumed)
				if err != nil {
					t.Fatal(err)
				}
				d.records[1] = []byte(strings.Replace(string(raw), string(port.HandoffConsumed), string(port.HandoffAcknowledged), 1))
			case "nonempty":
				d = &memoryDisk{}
				r := historyRecord(ack.Publication.Binding, ack.Publication.HandoffID, historyTurnSpec{"op", "owner", true})
				for step := 0; step < 2; step++ {
					raw, err := encode(r)
					if err != nil {
						t.Fatal(err)
					}
					d.records = append(d.records, raw)
					r = nextRecord(t, r)
				}
			}
			before := make([][]byte, len(d.records))
			for i, raw := range d.records {
				before[i] = append([]byte{}, raw...)
			}
			read := d.read
			if kind == "unknown" || kind == "read-failure" {
				// Native UNKNOWN/gap inventory is authored separately; this is
				// only a classified/error read at the shared scanner boundary.
				read = func(context.Context, int) ([]byte, bool, error) {
					if kind == "unknown" {
						return nil, false, fail(Unknown, true)
					}
					return nil, false, errors.New("read failed")
				}
			}
			chain, err := closedInspectionEmptyChainScan(context.Background(), roots, read)
			if err == nil {
				if kind == "extra-cycle" && (len(chain.stages) != 6 || !chain.head.EmptyRetirementChain || chain.head.Record.Stage != port.HandoffAcknowledged) {
					t.Fatal("extra-cycle fixture does not test an empty ACK head")
				}
				err = acknowledgedInspectionQualify(chain, ack.Publication.Binding, ack.Publication.HandoffID)
			}
			if err == nil || d.fenced || d.calls != 0 || len(before) != len(d.records) {
				t.Fatal("invalid prefix accepted or poisoned storage", err)
			}
			for i, raw := range before {
				if string(raw) != string(d.records[i]) {
					t.Fatal("inspection changed bytes")
				}
			}
		})
	}
}

func TestAcknowledgedInspectionPureExactBindingIDAndRoots(t *testing.T) {
	d, roots, ack := acknowledgedInspectionPureFixture(t)
	for _, kind := range []string{"id", "profile", "generation", "build", "host", "child", "parent", "chat", "parent-uid", "chat-uid", "current-profile", "current-parent", "current-chat"} {
		t.Run(kind, func(t *testing.T) {
			expected, id, current := ack.Publication.Binding, ack.Publication.HandoffID, roots
			switch kind {
			case "id":
				id = "other"
			case "profile":
				expected.ProfileID = "other"
			case "generation":
				expected.BackendGeneration = "other"
			case "build":
				expected.BuildID = "other"
			case "host":
				expected.HostLifetimeID = "other"
			case "child":
				expected.ChildLaunchID = "other"
			case "parent":
				expected.ParentRoot.Inode++
			case "chat":
				expected.ChatRoot.Inode++
			case "parent-uid":
				expected.ParentRoot.OwnerUID++
			case "chat-uid":
				expected.ChatRoot.OwnerUID++
			case "current-profile":
				current.ProfileID = "other"
			case "current-parent":
				current.Parent.Identity.Inode++
			case "current-chat":
				current.Chat.Identity.Inode++
			}
			chain, err := closedInspectionEmptyChainScan(context.Background(), current, d.read)
			if err == nil {
				err = acknowledgedInspectionQualify(chain, expected, id)
			}
			if err == nil || d.fenced || d.calls != 0 {
				t.Fatal("mismatched identity accepted or storage mutated", err)
			}
		})
	}
}

func TestAcknowledgedInspectionPureLeaseLateChangeCloseAndInput(t *testing.T) {
	d, roots, ack := acknowledgedInspectionPureFixture(t)
	chain, err := closedInspectionEmptyChainScan(context.Background(), roots, d.read)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"callback-changed", "root-latechanged", "close-error", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			changed, closes, checks := false, 0, 0
			closeErr := errors.New("close failed")
			l := &AcknowledgedLease{head: chain.head, verify: func() error {
				checks++
				if ctx.Err() != nil {
					return fail(Cancelled, false)
				}
				currentRoots := roots
				if kind == "root-latechanged" && changed {
					currentRoots.Chat.Identity.Inode++
				}
				current, err := closedInspectionEmptyChainScan(ctx, currentRoots, d.read)
				if err != nil {
					return err
				}
				if err := acknowledgedInspectionQualify(current, ack.Publication.Binding, ack.Publication.HandoffID); err != nil {
					return err
				}
				if changed && kind == "callback-changed" {
					return fail(Unavailable, false)
				}
				return nil
			}, close: func() error {
				closes++
				if kind == "close-error" {
					return closeErr
				}
				return nil
			}}
			if err := l.Verify(); err != nil || l.Observation() == nil {
				t.Fatal("initial observation failed", err)
			}
			if kind != "close-error" {
				// Simulate caller work between Observation and final Verify.
				changed = true
				if kind == "cancelled" {
					cancel()
				}
				failure := l.Verify()
				changed = false
				if failure == nil || l.Verify() != failure || checks != 2 || l.Observation() != nil {
					t.Fatal("late failure did not become sticky", failure)
				}
			}
			var want error
			if kind == "close-error" {
				want = closeErr
			}
			if !errors.Is(l.Close(), want) || !errors.Is(l.Close(), want) || closes != 1 || l.Observation() != nil || !errors.Is(l.Verify(), Unavailable) {
				t.Fatal("close contract differs")
			}
		})
	}
	var absent *AcknowledgedLease
	if absent.Observation() != nil || !errors.Is(absent.Verify(), Unavailable) || absent.Close() != nil {
		t.Fatal("nil lease contract differs")
	}
	zero := &AcknowledgedLease{}
	if zero.Observation() != nil || !errors.Is(zero.Verify(), Unavailable) || zero.Close() != nil {
		t.Fatal("zero lease contract differs")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []context.Context{nil, ctx} {
		if l, err := AcquireAcknowledgedInspection(c, roots, ack.Publication.Binding, ack.Publication.HandoffID); l != nil || !errors.Is(err, Cancelled) {
			t.Fatal("cancelled input reached disk", err)
		}
	}
	for _, kind := range []string{"id", "binding", "profile", "parent", "chat"} {
		expected, current, id := ack.Publication.Binding, roots, ack.Publication.HandoffID
		switch kind {
		case "id":
			id = " "
		case "binding":
			expected.HostLifetimeID = ""
		case "profile":
			current.ProfileID = "other"
		case "parent":
			current.Parent.Identity.Inode++
		case "chat":
			current.Chat.Identity.Inode++
		}
		if l, err := AcquireAcknowledgedInspection(context.Background(), current, expected, id); l != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid input reached disk", kind, err)
		}
	}
}

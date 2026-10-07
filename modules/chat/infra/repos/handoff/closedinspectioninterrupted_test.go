package handoff

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Canonical memory records only; no native files/claims or runtime ACK proof.
func TestInterruptedRetirementPureHandoffCompleteEmptyACKChain(t *testing.T) {
	for _, ancestor := range []bool{false, true} {
		d, roots, ack := acknowledgedInspectionPureFixture(t)
		if ancestor {
			d = &memoryDisk{}
			r := recordFixture()
			a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
			r = historyRecord(a.Consumption.NextBinding, "interrupted-handoff")
			for step := 0; step < 2; step++ {
				raw, err := encode(r)
				if err != nil {
					t.Fatal(err)
				}
				d.records = append(d.records, raw)
				ack = r
				if step == 0 {
					r = nextRecord(t, r)
				}
			}
		}
		b := ack.Publication.Binding
		scope := port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
		chain, err := closedInspectionEmptyChainScan(context.Background(), roots, d.read)
		if err != nil {
			t.Fatal(err)
		}
		got, err := interruptedRetirementInspectionValue(roots, scope, chain)
		if err != nil || got.Scope != scope || got.Publication != ack.Publication || got.HeadStage != port.HandoffAcknowledged || got.HeadDigest != sha256.Sum256(d.records[len(d.records)-1]) || len(got.Stages) != len(d.records) || got.Head == nil || got.Head.Record.Terminal != nil || got.Head.Record.Consumption != nil || got.NextBinding != (port.HandoffBinding{}) || got.AttemptID != "" || d.fenced || d.calls != 0 {
			t.Fatal("interrupted canonical chain differs", got, err)
		}
		if _, err := closedInspectionValue(roots, scope, chain); !errors.Is(err, Refused) {
			t.Fatal("ACK broadened ordinary consumed-only inspection", err)
		}
		l := &ClosedLease{value: got, verify: func() error { return nil }, close: func() error { return nil }}
		v, err := l.Observation()
		if err != nil {
			t.Fatal(err)
		}
		v.Head.Record.ACK.Publication.HandoffID = "changed"
		v.Head.Record.Receipt.Write.Turns = append(v.Head.Record.Receipt.Write.Turns, port.RetirementTurn{})
		v.Stages[0].Digest[0]++
		again, err := l.Observation()
		if err != nil || !reflect.DeepEqual(again, got) || again.Head == got.Head || again.Head.Record == got.Head.Record || again.Head.Record.ACK == got.Head.Record.ACK {
			t.Fatal("observation aliases retained ACK", err)
		}
		if _, ok := any(got).(port.CleanRetirement); ok {
			t.Fatal("ACK inspection became clean proof")
		}
	}
}

func TestInterruptedRetirementPureHandoffRefusalsNeverPoison(t *testing.T) {
	for _, kind := range []string{"empty", "captured", "terminated", "consumed", "scope", "profile", "parent", "chat", "nonempty-ancestor", "malformed", "noncanonical", "gap", "trailing-invalid", "read-unknown"} {
		t.Run(kind, func(t *testing.T) {
			d, roots, ack := acknowledgedInspectionPureFixture(t)
			b := ack.Publication.Binding
			scope := port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
			switch kind {
			case "empty":
				d.records = nil
			case "captured":
				d.records = d.records[:1]
			case "terminated", "consumed":
				r := nextRecord(t, ack)
				raw, _ := encode(r)
				d.records = append(d.records, raw)
				if kind == "consumed" {
					r = nextRecord(t, r)
					raw, _ = encode(r)
					d.records = append(d.records, raw)
				}
			case "scope":
				scope.BackendGeneration = "prior"
			case "profile":
				scope.ProfileID = "other"
			case "parent":
				roots.Parent.Identity.Inode++
			case "chat":
				roots.Chat.Identity.Inode++
			case "nonempty-ancestor":
				d = &memoryDisk{}
				r := historyRecord(b, "nonempty-ancestor", historyTurnSpec{"op", "owner", true})
				a := historyCycle(t, d, r, historyNextBinding(b, 2))
				r = historyRecord(a.Consumption.NextBinding, "empty-interrupted")
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
				scope = port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: a.Consumption.Next.BackendGeneration}
			case "malformed":
				d.records[0] = []byte("{}")
			case "noncanonical":
				d.records[0] = append(d.records[0], ' ')
			case "gap":
				d.records = d.records[1:]
			case "trailing-invalid":
				d.records = append(d.records, []byte("{}"))
			}
			before := make([]string, len(d.records))
			for i, raw := range d.records {
				before[i] = string(raw)
			}
			read := d.read
			if kind == "read-unknown" {
				read = func(context.Context, int) ([]byte, bool, error) { return nil, false, fail(Unknown, true) }
			}
			chain, err := closedInspectionEmptyChainScan(context.Background(), roots, read)
			if err == nil {
				_, err = interruptedRetirementInspectionValue(roots, scope, chain)
			}
			if err == nil || d.fenced || d.calls != 0 {
				t.Fatal("unsafe chain accepted or poisoned", err)
			}
			for i, raw := range d.records {
				if string(raw) != before[i] {
					t.Fatal("inspection changed canonical bytes")
				}
			}
		})
	}
	if _, err := interruptedRetirementInspectionValue(Roots{}, port.JournalScope{}, closedInspectionChain{}); !errors.Is(err, Refused) {
		t.Fatal("nil chain accepted", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []context.Context{nil, ctx} {
		if l, err := AcquireInterruptedRetirementInspection(c, Roots{}, port.JournalScope{}); l != nil || !errors.Is(err, Cancelled) {
			t.Fatal("cancelled input reached IO", err)
		}
	}
	if l, err := AcquireInterruptedRetirementInspection(context.Background(), Roots{}, port.JournalScope{}); l != nil || !errors.Is(err, Invalid) {
		t.Fatal("invalid input reached IO", err)
	}
}

func TestInterruptedRetirementPureHandoffLeaseFailureIsSticky(t *testing.T) {
	d, roots, ack := acknowledgedInspectionPureFixture(t)
	chain, err := closedInspectionEmptyChainScan(context.Background(), roots, d.read)
	if err != nil {
		t.Fatal(err)
	}
	b := ack.Publication.Binding
	got, err := interruptedRetirementInspectionValue(roots, port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, chain)
	if err != nil {
		t.Fatal(err)
	}
	checks, closes := 0, 0
	l := &ClosedLease{value: got, verify: func() error { checks++; return fail(Unavailable, false) }, close: func() error { closes++; return nil }}
	first := l.Verify()
	if first == nil || l.Verify() != first || checks != 1 {
		t.Fatal("failed verification was retried")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("failed lease exposed ACK")
	}
	if l.Close() != nil || l.Close() != nil || closes != 1 {
		t.Fatal("close was retried")
	}
}

package handoff

import (
	"context"
	"reflect"
	"testing"
	"time"
)

// CPU canonical chain fixtures only, without native files or custody proofs.
func TestPreservationChainUsesCanonicalNonemptyTransitionAndReplayPolicy(t *testing.T) {
	r := historyRecord(recordFixture().Publication.Binding, "preservation", historyTurnSpec{"operation", "owner", false})
	roots := Roots{ProfileID: r.Publication.Binding.ProfileID, Parent: Root{Identity: r.Publication.Binding.ParentRoot}, Chat: Root{Identity: r.Publication.Binding.ChatRoot}}
	d := &memoryDisk{}
	a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
	for _, count := range []int{0, 1, 2, 3, 4} {
		selected := &memoryDisk{records: append([][]byte(nil), d.records[:count]...)}
		chain, err := preservationChainScan(context.Background(), roots, selected.read)
		if err != nil || chain.head == nil || len(chain.stages) != count || selected.fenced || selected.calls != 0 {
			t.Fatal("canonical observation mutated or lost chain", count, err)
		}
		scope := r.Receipt.Write.Scope
		if count == 4 {
			scope = a.Consumption.Next
		}
		value, err := preservationValue(roots, scope, chain)
		if err != nil || len(value.Stages) != count {
			t.Fatal(count, err)
		}
		if count > 0 {
			if _, err := closedInspectionEmptyChainScan(context.Background(), roots, selected.read); err == nil {
				t.Fatal("nonempty preservation weakened empty policy")
			}
			wrong := scope
			wrong.BackendGeneration = "wrong-generation"
			if _, err := preservationValue(roots, wrong, chain); err == nil {
				t.Fatal("crossed scope qualified")
			}
		}
	}
	for _, kind := range []string{"damaged-ancestor", "omitted-ancestor", "duplicate-step", "cross-build"} {
		t.Run(kind, func(t *testing.T) {
			changed := &memoryDisk{records: append([][]byte(nil), d.records...)}
			switch kind {
			case "damaged-ancestor":
				changed.records[0] = append(append([]byte(nil), changed.records[0]...), ' ')
			case "omitted-ancestor":
				changed.records = changed.records[1:]
			case "duplicate-step":
				changed.records[2] = changed.records[1]
			case "cross-build":
				// An individually valid empty later retirement must not hide
				// the earlier nonempty ancestor at a cross-build consumption.
				empty := historyRecord(a.Consumption.NextBinding, "empty-successor")
				next := historyNextBinding(empty.Publication.Binding, 3)
				next.BuildID = "different-build"
				historyCycle(t, changed, empty, next)
			}
			original := append([][]byte(nil), changed.records...)
			if _, err := preservationChainScan(context.Background(), roots, changed.read); err == nil || changed.fenced || changed.calls != 0 || !reflect.DeepEqual(original, changed.records) {
				t.Fatal("invalid chain qualified or storage repaired", err)
			}
		})
	}
}

// Deterministic final-IO interleaving: the injected read-only verifier returns
// success after cancellation/absolute expiry. No real process or storage proof.
func TestPreservationVerifyWithdrawsContextExpiredDuringFinalIO(t *testing.T) {
	for _, kind := range []string{"cancel", "absolute-deadline"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var original context.Context = ctx
			var expire func()
			if kind == "cancel" {
				expire = cancel
			} else {
				until := time.Now().Add(100 * time.Millisecond)
				original = preservationContext{Context: context.Background(), until: until}
				expire = func() { time.Sleep(time.Until(until) + time.Millisecond) }
			}
			calls, closes := 0, 0
			l := &PreservationLease{ctx: original, lifetime: &ClosedLease{
				verify: func() error { calls++; expire(); return nil },
				close:  func() error { closes++; return nil },
			}}
			if l.Verify() == nil {
				t.Fatal("late successful IO restored expired preservation")
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("expired observation remained available")
			}
			if l.Verify() == nil || calls != 1 {
				t.Fatal("failed original verifier was repeated")
			}
			if l.Close() != nil || l.Close() != nil || closes != 1 {
				t.Fatal("cancelled lease lost owned cleanup")
			}
		})
	}
}

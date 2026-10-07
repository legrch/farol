package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
)

// CPU-only fixtures reuse the normal codec and full-chain transition scanner.
// Native directory names, locks and commit-file qualification are not exercised.
func TestClosedInspectionPureHandoffEntireEmptyConsumedChain(t *testing.T) {
	d := &memoryDisk{}
	r := recordFixture()
	a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
	roots := repoFixture(d).owner.roots
	for cycle := 1; cycle <= 2; cycle++ {
		if cycle == 2 {
			r = historyRecord(a.Consumption.NextBinding, "handoff-2")
			a = historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 3))
		}
		got, err := closedInspectionScan(context.Background(), roots, a.Consumption.Next, d.read)
		if err != nil || got.Scope != a.Consumption.Next || got.NextBinding != a.Consumption.NextBinding || got.ParentRoot != roots.Parent.Identity || got.ChatRoot != roots.Chat.Identity || got.HeadDigest != a.HeadDigest || got.HeadStage != port.HandoffConsumed || len(got.Stages) != len(d.records) || d.fenced || d.calls != 0 {
			t.Fatal("complete empty chain differs or storage mutated", got, err)
		}
		for index, raw := range d.records {
			decoded, err := decode(raw)
			if err != nil || got.Stages[index] != (ClosedInspectionStage{Index: index + 1, Stage: decoded.Stage, Digest: sha256.Sum256(raw)}) {
				t.Fatal("exact stage/digest lost", err)
			}
		}
		if _, ok := any(got).(port.CleanRetirement); ok {
			t.Fatal("diagnostic became origin proof")
		}
		if got.Head == nil || got.Head.Record == nil || !got.Head.EmptyRetirementChain || got.Head.Digest != got.HeadDigest || policy.ValidateRecord(*got.Head.Record) != nil {
			t.Fatal("missing exact validated internal head")
		}
		canonical, err := encode(*got.Head.Record)
		if err != nil || string(canonical) != string(d.records[len(d.records)-1]) {
			t.Fatal("head reconstructed instead of preserving original", err)
		}
		external, err := json.Marshal(got)
		if err != nil || strings.Contains(string(external), `"Head":`) || strings.Contains(string(external), `"Receipt":`) || strings.Contains(string(external), `"Terminal":`) || strings.Contains(string(external), `"ACK":`) || strings.Contains(string(external), `"Consumption":`) {
			t.Fatal("internal head entered external JSON", string(external), err)
		}
		err = closedInspectionCallback(context.Background(), got, func() error {
			again, err := encode(*got.Head.Record)
			if err != nil || string(again) != string(canonical) {
				t.Fatal("callback mutated retained head", err)
			}
			return nil
		}, func(v ClosedInspection) error {
			v.Head.Digest[0]++
			v.Head.EmptyRetirementChain = false
			v.Head.Record.Publication.HandoffID = "changed"
			v.Head.Record.Receipt.Write.Turns = append(v.Head.Record.Receipt.Write.Turns, port.RetirementTurn{})
			v.Head.Record.ACK.Publication.HandoffID = "changed"
			v.Head.Record.Terminal.Publication.HandoffID = "changed"
			*v.Head.Record.Terminal.ExitCode = 99
			v.Head.Record.Consumption.Next.BackendGeneration = "changed"
			v.Stages[0].Digest[0]++
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestClosedInspectionPureHandoffRefusalsNeverPoison(t *testing.T) {
	for _, kind := range []string{"empty-store", "captured", "acknowledged", "terminated", "scope", "root", "nonempty-origin", "nonempty-ancestor", "malformed", "noncanonical", "gap", "trailing-invalid", "read-failure"} {
		t.Run(kind, func(t *testing.T) {
			d := &memoryDisk{}
			r := recordFixture()
			if kind == "nonempty-origin" || kind == "nonempty-ancestor" {
				r = historyRecord(r.Publication.Binding, "nonempty", historyTurnSpec{"op", "owner", true})
			}
			a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
			if kind == "nonempty-ancestor" {
				r = historyRecord(a.Consumption.NextBinding, "empty-successor")
				a = historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 3))
			}
			roots, scope := repoFixture(d).owner.roots, a.Consumption.Next
			switch kind {
			case "empty-store":
				d.records = nil
			case "captured":
				d.records = d.records[:1]
			case "acknowledged":
				d.records = d.records[:2]
			case "terminated":
				d.records = d.records[:3]
			case "scope":
				scope.BackendGeneration = "crossed"
			case "root":
				roots.Chat.Identity.Inode++
			case "malformed":
				d.records[0] = []byte("{}")
			case "noncanonical":
				d.records[0] = append(d.records[0], ' ')
			case "gap":
				d.records = append(d.records[:1], d.records[2:]...)
			case "trailing-invalid":
				d.records = append(d.records, []byte("{}"))
			}
			read := d.read
			if kind == "read-failure" {
				read = func(context.Context, int) ([]byte, bool, error) { return nil, false, errors.New("read failed") }
			}
			if got, err := closedInspectionScan(context.Background(), roots, scope, read); err == nil || got.HeadDigest != ([32]byte{}) || d.fenced || d.calls != 0 {
				t.Fatal("invalid chain accepted or inspection poisoned storage", got, err)
			}
		})
	}
	// Exact maxSteps and its first excess cycle use the same scanner budget.
	d := &memoryDisk{}
	b := recordFixture().Publication.Binding
	var a port.HistoryAnchor
	for cycle := 1; cycle <= maxSteps/4+1; cycle++ {
		a = historyCycle(t, d, historyRecord(b, fmt.Sprintf("empty-%d", cycle)), historyNextBinding(b, cycle+1))
		b = a.Consumption.NextBinding
		if cycle < maxSteps/4 {
			continue
		}
		_, err := closedInspectionScan(context.Background(), repoFixture(d).owner.roots, a.Consumption.Next, d.read)
		if cycle == maxSteps/4 && err != nil || cycle > maxSteps/4 && err == nil || d.fenced || d.calls != 0 {
			t.Fatal("chain budget differs or storage mutated", cycle, err)
		}
	}
}

func TestClosedInspectionPureHandoffCallbackAndInput(t *testing.T) {
	callbackErr := errors.New("caller stopped")
	for _, kind := range []string{"success", "callback-error", "recheck-error", "cancelled-before", "cancelled-during"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if kind == "cancelled-before" {
				cancel()
			}
			value := ClosedInspection{Stages: []ClosedInspectionStage{{Index: 1}}}
			order := ""
			err := closedInspectionCallback(ctx, value, func() error {
				order += "recheck"
				if kind == "recheck-error" {
					return Refused
				}
				return nil
			}, func(v ClosedInspection) error {
				order += "callback/"
				v.Stages[0].Index = 99
				if kind == "cancelled-during" {
					cancel()
				}
				if kind == "callback-error" || kind == "recheck-error" {
					return callbackErr
				}
				return nil
			})
			var want error
			switch kind {
			case "callback-error":
				want = callbackErr
			case "recheck-error":
				want = Refused
			case "cancelled-before", "cancelled-during":
				want = Cancelled
			}
			if !errors.Is(err, want) || value.Stages[0].Index != 1 || kind == "cancelled-before" && order != "" || kind != "cancelled-before" && order != "callback/recheck" {
				t.Fatal("callback/recheck contract differs", order, err)
			}
		})
	}
	if err := WithClosedInspection(nil, Roots{}, port.JournalScope{}, nil); !errors.Is(err, Cancelled) {
		t.Fatal("invalid input accepted", err)
	}
}

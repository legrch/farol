package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Memory fixtures exercise the canonical codec and full-chain scanner only.
// They establish no filesystem, process, live ACK or clean-retirement proof.
func terminatedInspectionPureFixture(t *testing.T, ancestor bool) (*memoryDisk, Roots, port.JournalScope, port.HandoffRecord) {
	t.Helper()
	d := &memoryDisk{}
	r := recordFixture()
	if ancestor {
		a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
		r = historyRecord(a.Consumption.NextBinding, "terminated-successor")
	}
	r = terminatedInspectionPureAppend(t, d, r)
	b := r.Publication.Binding
	return d, repoFixture(d).owner.roots, port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, r
}

func terminatedInspectionPureAppend(t *testing.T, d *memoryDisk, r port.HandoffRecord) port.HandoffRecord {
	t.Helper()
	for step := 0; step < 3; step++ {
		raw, err := encode(r)
		if err != nil {
			t.Fatal(err)
		}
		d.records = append(d.records, raw)
		if step < 2 {
			r = nextRecord(t, r)
		}
	}
	return r
}

func TestTerminatedRetirementInspectionPureEntireEmptyChainAndCopy(t *testing.T) {
	for _, ancestor := range []bool{false, true} {
		d, roots, scope, terminal := terminatedInspectionPureFixture(t, ancestor)
		chain, err := closedInspectionEmptyChainScan(context.Background(), roots, d.read)
		if err != nil {
			t.Fatal(err)
		}
		got, err := terminatedRetirementInspectionValue(roots, scope, chain)
		if err != nil || got.Scope != scope || got.Publication != terminal.Publication || got.ParentRoot != roots.Parent.Identity || got.ChatRoot != roots.Chat.Identity || got.HeadStage != port.HandoffTerminated || got.HeadDigest != sha256.Sum256(d.records[len(d.records)-1]) || len(got.Stages) != len(d.records) || got.NextBinding != (port.HandoffBinding{}) || got.AttemptID != "" {
			t.Fatal("terminated observation differs", got, err)
		}
		if got.Head == nil || !reflect.DeepEqual(*got.Head.Record, terminal) || got.Head == chain.head || got.Head.Record == chain.head.Record {
			t.Fatal("head was reconstructed or aliases scanner")
		}
		for i, raw := range d.records {
			r, err := decode(raw)
			if err != nil || got.Stages[i] != (ClosedInspectionStage{Index: i + 1, Stage: r.Stage, Digest: sha256.Sum256(raw)}) {
				t.Fatal("canonical prefix metadata differs", err)
			}
		}
		if terminal.Terminal.KnownACKDigest != sha256.Sum256(d.records[len(d.records)-2]) {
			t.Fatal("terminal lost canonical original ACK")
		}
		if _, err := closedInspectionValue(roots, scope, chain); !errors.Is(err, Refused) {
			t.Fatal("terminated head broadened consumed-only API", err)
		}
		if _, err := interruptedRetirementInspectionValue(roots, scope, chain); !errors.Is(err, Refused) {
			t.Fatal("terminated head broadened ACK-only API", err)
		}
		if err := acknowledgedInspectionQualify(chain, terminal.Publication.Binding, terminal.Publication.HandoffID); !errors.Is(err, Refused) {
			t.Fatal("terminated head broadened initial ACK prefix", err)
		}
		external, err := json.Marshal(got)
		if err != nil || strings.Contains(string(external), `"Head":`) || strings.Contains(string(external), `"Receipt":`) || strings.Contains(string(external), `"Terminal":`) || strings.Contains(string(external), `"ACK":`) || strings.Contains(string(external), `"Consumption":`) {
			t.Fatal("private head entered external metadata", err)
		}
		if _, ok := any(got).(port.CleanRetirement); ok {
			t.Fatal("observation became origin proof")
		}
		l := &ClosedLease{value: got, verify: func() error { return nil }, close: func() error { return nil }}
		v, err := l.Observation()
		if err != nil {
			t.Fatal(err)
		}
		v.Head.Digest[0]++
		v.Head.EmptyRetirementChain = false
		v.Head.Record.Publication.HandoffID = "changed"
		v.Head.Record.ACK.Publication.Binding.ChildLaunchID = "changed"
		v.Head.Record.Terminal.Publication.HandoffID = "changed"
		v.Head.Record.Terminal.KnownACKDigest[0]++
		*v.Head.Record.Terminal.ExitCode = 99
		v.Head.Record.Receipt.Write.Turns = append(v.Head.Record.Receipt.Write.Turns, port.RetirementTurn{})
		v.Stages[0].Digest[0]++
		again, err := l.Observation()
		if err != nil || !reflect.DeepEqual(again, got) || again.Head == got.Head || again.Head.Record.ACK == got.Head.Record.ACK || again.Head.Record.Terminal.ExitCode == got.Head.Record.Terminal.ExitCode || d.fenced || d.calls != 0 {
			t.Fatal("returned metadata aliases retained observation or wrote storage", err)
		}
		if l.Verify() != nil || l.Close() != nil {
			t.Fatal("lease failed")
		}
	}
}

func TestTerminatedRetirementInspectionPureRefusalsNeverPoison(t *testing.T) {
	for _, kind := range []string{
		"empty", "captured", "acknowledged", "consumed", "scope", "profile", "parent", "chat", "parent-uid", "chat-uid",
		"nonempty-head", "nonempty-ancestor", "malformed", "noncanonical", "unknown-field", "gap", "trailing-invalid", "read-unknown",
		"missing-ack", "wrong-ack-publication", "missing-terminal", "wrong-terminal-publication", "zero-ack-digest", "wrong-ack-digest",
		"wrong-kind", "wrong-stop", "missing-exit", "nonzero-exit", "signal", "consumption", "wrong-origin",
	} {
		t.Run(kind, func(t *testing.T) {
			d, roots, scope, terminal := terminatedInspectionPureFixture(t, false)
			switch kind {
			case "empty":
				d.records = nil
			case "captured":
				d.records = d.records[:1]
			case "acknowledged":
				d.records = d.records[:2]
			case "consumed":
				raw, _ := encode(nextRecord(t, terminal))
				d.records = append(d.records, raw)
			case "scope":
				scope.BackendGeneration = "next"
			case "profile":
				scope.ProfileID = "other"
			case "parent":
				roots.Parent.Identity.Inode++
			case "chat":
				roots.Chat.Identity.Inode++
			case "parent-uid":
				roots.Parent.Identity.OwnerUID++
			case "chat-uid":
				roots.Chat.Identity.OwnerUID++
			case "nonempty-head", "nonempty-ancestor":
				d = &memoryDisk{}
				r := historyRecord(terminal.Publication.Binding, "nonempty", historyTurnSpec{"op", "owner", true})
				if kind == "nonempty-ancestor" {
					a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
					r = historyRecord(a.Consumption.NextBinding, "empty-successor")
				}
				terminal = terminatedInspectionPureAppend(t, d, r)
				scope.BackendGeneration = terminal.Publication.Binding.BackendGeneration
			case "malformed":
				d.records[0] = []byte("{}")
			case "noncanonical":
				d.records[2] = append(d.records[2], ' ')
			case "unknown-field":
				d.records[2] = []byte(strings.TrimSuffix(string(d.records[2]), "}") + `,"Unknown":true}`)
			case "gap":
				d.records = append(d.records[:1], d.records[2])
			case "trailing-invalid":
				d.records = append(d.records, []byte("{}"))
			case "read-unknown":
			default:
				switch kind {
				case "missing-ack":
					terminal.ACK = nil
				case "wrong-ack-publication":
					terminal.ACK.Publication.HandoffID = "other"
				case "missing-terminal":
					terminal.Terminal = nil
				case "wrong-terminal-publication":
					terminal.Terminal.Publication.Binding.ChildLaunchID = "other"
				case "zero-ack-digest":
					terminal.Terminal.KnownACKDigest = [32]byte{}
				case "wrong-ack-digest":
					terminal.Terminal.KnownACKDigest[0]++
				case "wrong-kind":
					terminal.Terminal.Kind = "other"
				case "wrong-stop":
					terminal.Terminal.StopMode = "other"
				case "missing-exit":
					terminal.Terminal.ExitCode = nil
				case "nonzero-exit":
					*terminal.Terminal.ExitCode = 1
				case "signal":
					terminal.Terminal.Signal = "SIGTERM"
				case "consumption":
					terminal.Consumption = nextRecord(t, terminal).Consumption
				case "wrong-origin":
					terminal.Origin = "other"
				}
				// Deliberately bypass encode's policy guard to feed invalid boundary
				// data into the actual scanner, never into a native fixture.
				raw, err := json.Marshal(terminal)
				if err != nil {
					t.Fatal(err)
				}
				d.records[2] = raw
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
				_, err = terminatedRetirementInspectionValue(roots, scope, chain)
			}
			if err == nil || d.fenced || d.calls != 0 {
				t.Fatal("invalid chain accepted or poisoned", err)
			}
			for i, raw := range d.records {
				if string(raw) != before[i] {
					t.Fatal("inspection changed bytes")
				}
			}
		})
	}
	if _, err := terminatedRetirementInspectionValue(Roots{}, port.JournalScope{}, closedInspectionChain{}); !errors.Is(err, Refused) {
		t.Fatal("missing head accepted", err)
	}
}

func TestTerminatedRetirementInspectionPureLateCallbackChangeAndStickyLease(t *testing.T) {
	for _, kind := range []string{"bytes", "root", "cancelled", "callback-error", "copy-only"} {
		t.Run(kind, func(t *testing.T) {
			d, roots, scope, _ := terminatedInspectionPureFixture(t, true)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			chain, err := closedInspectionEmptyChainScan(ctx, roots, d.read)
			if err != nil {
				t.Fatal(err)
			}
			value, err := terminatedRetirementInspectionValue(roots, scope, chain)
			if err != nil {
				t.Fatal(err)
			}
			checks, closes := 0, 0
			l := &ClosedLease{value: value, verify: func() error {
				checks++
				if ctx.Err() != nil {
					return fail(Cancelled, false)
				}
				current, err := closedInspectionEmptyChainScan(ctx, roots, d.read)
				if err != nil {
					return err
				}
				got, err := terminatedRetirementInspectionValue(roots, scope, current)
				if err != nil || got.HeadDigest != value.HeadDigest {
					return fail(Refused, false)
				}
				return nil
			}, close: func() error { closes++; return nil }}
			v, err := l.Observation()
			if err != nil {
				t.Fatal(err)
			}
			callbackErr := errors.New("caller refused")
			err = closedInspectionCallback(ctx, v, l.Verify, func(v ClosedInspection) error {
				*v.Head.Record.Terminal.ExitCode = 99
				v.Stages[0].Index++
				switch kind {
				case "bytes":
					d.records[len(d.records)-1] = append(d.records[len(d.records)-1], ' ')
				case "root":
					roots.Chat.Identity.Inode++
				case "cancelled":
					cancel()
				case "callback-error":
					return callbackErr
				}
				return nil
			})
			if kind == "copy-only" || kind == "callback-error" {
				var want error
				if kind == "callback-error" {
					want = callbackErr
				}
				again, observed := l.Observation()
				if !errors.Is(err, want) || observed != nil || !reflect.DeepEqual(again, value) || checks != 1 {
					t.Fatal("callback copy/error or final check differs", err)
				}
			} else {
				failure := l.Verify()
				if err == nil || failure == nil || l.Verify() != failure || checks != 1 {
					t.Fatal("late failure retried or accepted", err)
				}
				if _, err := l.Observation(); err == nil {
					t.Fatal("failed lease exposed stale metadata")
				}
			}
			if l.Close() != nil || l.Close() != nil || closes != 1 || d.fenced || d.calls != 0 {
				t.Fatal("close retried or observation wrote storage")
			}
		})
	}
}

func TestTerminatedRetirementInspectionPureInputAndUnsupportedGuard(t *testing.T) {
	d, roots, scope, _ := terminatedInspectionPureFixture(t, false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []context.Context{nil, ctx} {
		if l, err := AcquireTerminatedRetirementInspection(c, roots, scope); l != nil || !errors.Is(err, Cancelled) {
			t.Fatal("cancelled input reached native acquisition", err)
		}
	}
	for _, kind := range []string{"profile", "generation", "mismatch"} {
		current, selected := roots, scope
		switch kind {
		case "profile":
			current.ProfileID = ""
		case "generation":
			selected.BackendGeneration = " "
		case "mismatch":
			selected.ProfileID = "other"
		}
		if l, err := AcquireTerminatedRetirementInspection(context.Background(), current, selected); l != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid input reached native acquisition", kind, err)
		}
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		if l, err := AcquireTerminatedRetirementInspection(context.Background(), roots, scope); l != nil || !errors.Is(err, Unavailable) {
			t.Fatal("unsupported host acquired a lease", err)
		}
	}
	if d.calls != 0 || d.fenced {
		t.Fatal("input guards mutated storage")
	}
}

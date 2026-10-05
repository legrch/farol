package lifecycle

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Pure canonical fixtures only: these tests prove no native filesystem/locking,
// startup outcome, profile inventory or origin-qualified retirement.
var inspectionLimits = Limits{Bytes: 1024 * 1024, Records: 256}

func inspectionFixtureRoot() Root {
	return Root{ProfileID: scope.ProfileID, Device: fixtureRoot.Device, Inode: fixtureRoot.Inode, OwnerUID: fixtureRoot.OwnerUID}
}

func inspectionEmptyRecord() record {
	return record{Version: 3, Root: fixtureRoot, Scope: scope, Incarnations: []string{scope.BackendGeneration}, Writes: []port.JournalWrite{}}
}

func inspectionEncode(t *testing.T, value record) []byte {
	t.Helper()
	raw, err := encode(value, inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestLifecycleInspectionCanonicalClassification(t *testing.T) {
	for _, name := range []string{"first_v2", "first_v3", "successor_empty", "admitted", "two_turns", "empty_retirement", "terminal", "terminal_retirement", "unknown_send"} {
		t.Run(name, func(t *testing.T) {
			value := inspectionEmptyRecord()
			wantEmpty, wantWrites, wantTurns := false, 0, 0
			switch name {
			case "first_v2", "first_v3":
				wantEmpty = true
				if name == "first_v2" {
					value.Version = 2
				}
			case "successor_empty":
				value.Incarnations = []string{"earlier-backend", scope.BackendGeneration}
			case "admitted", "two_turns":
				value.Writes = []port.JournalWrite{admissionWrite(t)}
				wantWrites, wantTurns = 1, 1
				if name == "two_turns" {
					b := binding()
					b.OperationID, b.TurnID = "operation-2", "turn-2"
					q, _ := turn.NewQueue(scope.ProfileID, scope.BackendGeneration)
					q.Admit(identity(binding()), digest)
					after, err := q.Admit(identity(b), digest)
					if err != nil {
						t.Fatal(err)
					}
					value.Writes = append(value.Writes, port.JournalWrite{Scope: scope, PreviousRevision: 1, Revision: 2, Entry: port.JournalEntry{Binding: b, Kind: "admit", IntentDigest: digest, After: after}})
					wantWrites, wantTurns = 2, 2
				}
			case "empty_retirement":
				value.Retirement = &port.RetirementWrite{Scope: scope, Root: fixtureRoot, Revision: 1, Turns: []port.RetirementTurn{}}
			case "terminal", "terminal_retirement":
				r, p, owner, _ := liveFixture(t, false)
				if name == "terminal_retirement" {
					if _, err := owner.Retire(context.Background()); err != nil {
						t.Fatal(err)
					}
				}
				var err error
				value, err = decode(p.raw, r.owner.limits)
				if err != nil {
					t.Fatal(err)
				}
				wantWrites, wantTurns = 3, 1
			case "unknown_send":
				value = inspectionUnknownRecord(t)
				wantWrites, wantTurns = 6, 1
			}
			raw := inspectionEncode(t, value)
			before := append([]byte(nil), raw...)
			got, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits)
			if err != nil || got == nil {
				t.Fatal(got, err)
			}
			if got.Scope != value.Scope || got.Root != value.Root || got.Version != value.Version || got.SnapshotDigest != sha256.Sum256(raw) || got.EmptyFirstIncarnation != wantEmpty || got.WriteCount != wantWrites || got.TurnCount != wantTurns || strings.Join(got.Incarnations, ",") != strings.Join(value.Incarnations, ",") || !bytes.Equal(raw, before) {
				t.Fatal("incorrect snapshot-only metadata", got)
			}
			if w := value.Retirement; w != nil {
				if got.Retirement == nil || got.Retirement.PreviousRevision != w.PreviousRevision || got.Retirement.Revision != w.Revision || got.Retirement.TurnCount != len(w.Turns) {
					t.Fatal("retirement metadata changed", got.Retirement)
				}
			} else if got.Retirement != nil {
				t.Fatal("invented retirement")
			}
			if _, ok := any(got).(port.CleanRetirement); ok {
				t.Fatal("inspection became origin proof")
			}
			if _, ok := any(got.Retirement).(port.CleanRetirement); ok {
				t.Fatal("recorded retirement became origin proof")
			}
			serialized, err := json.Marshal(got)
			if err != nil || strings.Contains(string(serialized), "IntentDigest") || strings.Contains(string(serialized), "Result") || strings.Contains(string(serialized), "Prompt") || strings.Contains(string(serialized), "Payload") || strings.Contains(string(serialized), "Quiescence") || strings.Contains(string(serialized), "Snapshot\"") {
				t.Fatal("inspection exposed history/body/proof fields", err)
			}
			got.Incarnations[0] = "caller-mutated"
			again, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits)
			if err != nil || again.Incarnations[0] != value.Incarnations[0] {
				t.Fatal("caller mutation escaped inspection value", err)
			}
		})
	}
}

func inspectionUnknownRecord(t *testing.T) record {
	t.Helper()
	value := inspectionEmptyRecord()
	q, _ := turn.NewQueue(scope.ProfileID, scope.BackendGeneration)
	b := binding()
	appendWrite := func(kind string, before, after turn.Snapshot, effect, intent string) {
		n := uint64(len(value.Writes))
		value.Writes = append(value.Writes, port.JournalWrite{Scope: scope, PreviousRevision: n, Revision: n + 1, Entry: port.JournalEntry{Binding: b, Kind: kind, Before: before, After: after, Effect: effect, IntentDigest: intent, Closed: after.HasResult}})
	}
	after, err := q.Admit(identity(b), digest)
	if err != nil {
		t.Fatal(err)
	}
	appendWrite("admit", turn.Snapshot{}, after, "", digest)
	before := after
	after, err = q.Enqueue(identity(b))
	if err != nil {
		t.Fatal(err)
	}
	appendWrite("enqueue", before, after, "", "")
	before = after
	r, err := q.Reserve()
	if err != nil {
		t.Fatal(err)
	}
	after, _ = q.Snapshot(identity(b))
	appendWrite("reserve", before, after, "prepare", "")
	before = after
	after, err = q.Bind(r, turn.Document{ProviderState: turn.ProviderHome, ViewID: "fixture-view", ViewGeneration: 1, DocumentGeneration: 1})
	if err != nil {
		t.Fatal(err)
	}
	appendWrite("prepared", before, after, "", "")
	before = after
	after, err = q.Dispatch(after.Binding)
	if err != nil {
		t.Fatal(err)
	}
	appendWrite("dispatch", before, after, "send", "")
	before = after
	after, err = q.Finish(after.Binding, turn.Result{ID: "fixture-unknown-result", Outcome: turn.UnknownOutcome, Code: "SEND_OUTCOME_UNKNOWN"})
	if err != nil {
		t.Fatal(err)
	}
	appendWrite("send-settled", before, after, "", "")
	return value
}

func TestLifecycleInspectionRejectsNoncanonicalScopeRootAndOverflow(t *testing.T) {
	raw := inspectionEncode(t, inspectionEmptyRecord())
	if got, err := inspectRecord(raw, inspectionFixtureRoot(), Limits{Bytes: len(raw), Records: 1}); err != nil || got == nil || !got.EmptyFirstIncarnation {
		t.Fatal("exact accepted byte/incarnation budget refused", got, err)
	}
	for _, bad := range [][]byte{
		nil, append(append([]byte(nil), raw...), ' '), append(append([]byte(nil), raw...), []byte(" {}")...),
		[]byte(strings.Replace(string(raw), `"version":3`, `"version":3,"version":3`, 1)),
		[]byte(strings.Replace(string(raw), `"version":3`, `"version":3,"Prompt":"fixture-private"`, 1)),
		[]byte(strings.Replace(string(raw), `"writes":[]`, `"writes":null`, 1)),
		[]byte(strings.Replace(string(raw), `"version":3`, `"version":3.0`, 1)),
		[]byte(strings.Replace(string(raw), `"incarnations":["backend"]`, `"incarnations":["backend","backend"]`, 1)),
	} {
		if got, err := inspectRecord(bad, inspectionFixtureRoot(), inspectionLimits); got != nil || !errors.Is(err, Invalid) || strings.Contains(err.Error(), "fixture-private") {
			t.Fatal("noncanonical content accepted/leaked", got, err)
		}
	}
	for _, mutate := range []func(*Root){
		func(r *Root) { r.ProfileID = "other-profile" }, func(r *Root) { r.Device++ },
		func(r *Root) { r.Inode++ }, func(r *Root) { r.OwnerUID++ },
	} {
		root := inspectionFixtureRoot()
		mutate(&root)
		if got, err := inspectRecord(raw, root, inspectionLimits); got != nil || !errors.Is(err, Refused) {
			t.Fatal("crossed physical root/profile", got, err)
		}
	}
	if got, err := inspectRecord(raw, inspectionFixtureRoot(), Limits{Bytes: len(raw) - 1, Records: 256}); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("byte overflow", got, err)
	}
	value := inspectionEmptyRecord()
	value.Incarnations = []string{"old", scope.BackendGeneration}
	raw = inspectionEncode(t, value)
	if got, err := inspectRecord(raw, inspectionFixtureRoot(), Limits{Bytes: len(raw), Records: 1}); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("incarnation overflow", got, err)
	}
	value = inspectionUnknownRecord(t)
	raw = inspectionEncode(t, value)
	if got, err := inspectRecord(raw, inspectionFixtureRoot(), Limits{Bytes: len(raw), Records: len(value.Writes) - 1}); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("write overflow", got, err)
	}
	// Raw canonical JSON with a write from another scope must still fail the
	// existing semantic decoder, rather than being summarized as diagnostic use.
	value.Writes[0].Scope.BackendGeneration = "crossed-backend"
	raw, _ = json.Marshal(value)
	if got, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("crossed write scope", got, err)
	}
	r, p, owner, _ := liveFixture(t, false)
	if _, err := owner.Retire(context.Background()); err != nil {
		t.Fatal(err)
	}
	value, err := decode(p.raw, r.owner.limits)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := inspectRecord(p.raw, inspectionFixtureRoot(), Limits{Bytes: len(p.raw), Records: len(value.Writes)}); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("retirement record overflow", got, err)
	}
	value = inspectionEmptyRecord()
	value.Retirement = &port.RetirementWrite{Scope: scope, Root: fixtureRoot, Revision: 1, Turns: []port.RetirementTurn{}}
	value.Retirement.Revision++
	// Bypass the encoder to challenge the production decoder's semantic checks.
	raw, _ = json.Marshal(value)
	if got, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits); got != nil || !errors.Is(err, Invalid) {
		t.Fatal("invalid recorded retirement", got, err)
	}
}

func TestLifecycleInspectionValidationBeforeNativeIO(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, ctxCase := range []context.Context{nil, ctx} {
		if got, err := Inspect(ctxCase, Root{}, Limits{}); got != nil || !errors.Is(err, Cancelled) {
			t.Fatal(got, err)
		}
	}
	for _, limits := range []Limits{{}, {Bytes: math.MaxInt, Records: 1}, {Bytes: 1}, {Bytes: -1, Records: 1}} {
		if got, err := Inspect(context.Background(), inspectionFixtureRoot(), limits); got != nil || !errors.Is(err, Invalid) {
			t.Fatal(got, err)
		}
	}
	root := inspectionFixtureRoot()
	root.ProfileID = "bad profile"
	if got, err := Inspect(context.Background(), root, inspectionLimits); got != nil || !errors.Is(err, Invalid) {
		t.Fatal(got, err)
	}
}

func TestLifecycleInspectionCannotResolveLostStartOrRetirementACK(t *testing.T) {
	// Known and lost OpenFresh replies can leave identical canonical bytes. The
	// diagnostic must not add authority based on the snapshot's emptiness.
	for _, lost := range []bool{false, true} {
		p := &physicalFixture{createFault: lost}
		r, err := claimFixture(t, p)
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.OpenFresh(context.Background(), scope)
		if lost && !errors.Is(err, Unknown) || !lost && err != nil {
			t.Fatal(err)
		}
		got, err := inspectRecord(p.raw, inspectionFixtureRoot(), inspectionLimits)
		if err != nil || !got.EmptyFirstIncarnation || !p.claim || p.creates != 1 || p.replaces != 0 {
			t.Fatal("unknown Start fence changed", got, err)
		}
		if _, err := claimFixture(t, p); !errors.Is(err, Refused) {
			t.Fatal("diagnostic admitted fresh writer", err)
		}
	}
	r, p, owner, _ := liveFixture(t, false)
	p.replaceFault = true
	if origin, err := owner.Retire(context.Background()); origin != nil || err == nil {
		t.Fatal("fixture must lose retirement ACK", err)
	}
	writes, closes := p.replaces, p.closes
	got, err := inspectRecord(p.raw, inspectionFixtureRoot(), inspectionLimits)
	if err != nil || got.Retirement == nil || got.EmptyFirstIncarnation || p.replaces != writes || p.closes != closes || !r.owner.poisoned || !p.claim {
		t.Fatal("inspection discharged lost retirement ACK", got, err)
	}
	if _, err := owner.Retire(context.Background()); err == nil || p.replaces != writes {
		t.Fatal("inspection supplied retry permission", err)
	}
}

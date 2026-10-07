package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func interruptedRetirementPureRecord() record {
	r := inspectionEmptyRecord()
	r.Retirement = &port.RetirementWrite{Scope: r.Scope, Root: r.Root, Revision: 1, Turns: []port.RetirementTurn{}}
	return r
}

// CPU-only canonical metadata and lease callbacks. No native files or locks.
func TestInterruptedRetirementPureLifecycleExactWriteAndCopy(t *testing.T) {
	for _, version := range []int{2, 3} {
		r := interruptedRetirementPureRecord()
		r.Version = version
		if version == 3 {
			r.Incarnations = []string{"prior", scope.BackendGeneration}
		}
		raw := inspectionEncode(t, r)
		got, err := interruptedRetirementInspectionMetadata(raw, inspectionFixtureRoot(), scope, inspectionLimits)
		if err != nil || got.Scope != scope || got.Root != fixtureRoot || got.SnapshotDigest != sha256.Sum256(raw) || got.Version != version || got.Revision != 1 || got.Retirement == nil || !port.SameRetirement(*got.Retirement, *r.Retirement) {
			t.Fatal("exact retired metadata differs", got, err)
		}
		observed, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := closedInspectionMetadata(observed, scope); !errors.Is(err, Refused) {
			t.Fatal("retirement broadened ordinary closed inspection", err)
		}
		before := port.CopyRetirement(*got.Retirement)
		l := &ClosedLease{value: got, verify: func() error { return nil }, close: func() error { return nil }}
		v, err := l.Observation()
		if err != nil {
			t.Fatal(err)
		}
		v.Retirement.Scope.BackendGeneration = "changed"
		v.Retirement.Turns = append(v.Retirement.Turns, port.RetirementTurn{})
		v.Incarnations[0] = "changed"
		again, err := l.Observation()
		if err != nil || !port.SameRetirement(*again.Retirement, before) || !reflect.DeepEqual(again.Incarnations, got.Incarnations) || again.Retirement == got.Retirement {
			t.Fatal("lease observation aliases retained retirement", err)
		}
		if err := closedInspectionCallback(context.Background(), got, func() error { return nil }, func(v ClosedInspection) error {
			v.Retirement.Root.Inode++
			return nil
		}); err != nil || !port.SameRetirement(*got.Retirement, before) {
			t.Fatal("callback aliases retained retirement", err)
		}
		if _, ok := any(got).(port.CleanRetirement); ok {
			t.Fatal("inspection manufactured CleanRetirement")
		}
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		var external map[string]json.RawMessage
		if json.Unmarshal(data, &external) != nil || external["Retirement"] != nil {
			t.Fatal("internal retirement entered diagnostics")
		}
	}
}

func TestInterruptedRetirementPureLifecycleRefusals(t *testing.T) {
	for _, kind := range []string{"unretired", "admitted", "unknown", "scope", "root", "retirement-scope", "retirement-root", "revision", "previous-revision", "nil-turns", "nonempty-retirement", "noncanonical", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			r := interruptedRetirementPureRecord()
			current, root := scope, inspectionFixtureRoot()
			switch kind {
			case "unretired":
				r.Retirement = nil
			case "admitted":
				r = inspectionEmptyRecord()
				r.Writes = []port.JournalWrite{admissionWrite(t)}
			case "unknown":
				r = inspectionUnknownRecord(t)
			case "scope":
				current.BackendGeneration = "prior"
			case "root":
				root.Inode++
			case "retirement-scope":
				r.Retirement.Scope.BackendGeneration = "prior"
			case "retirement-root":
				r.Retirement.Root.Inode++
			case "revision":
				r.Retirement.Revision++
			case "previous-revision":
				r.Retirement.PreviousRevision++
			case "nil-turns":
				r.Retirement.Turns = nil
			case "nonempty-retirement":
				r.Retirement.Turns = []port.RetirementTurn{{}}
			}
			raw, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "noncanonical" {
				raw = append(raw, ' ')
			} else if kind == "malformed" {
				raw = []byte("{}")
			}
			before := string(raw)
			if v, err := interruptedRetirementInspectionMetadata(raw, root, current, inspectionLimits); err == nil || v.Retirement != nil || string(raw) != before {
				t.Fatal("unsafe retired inspection accepted or mutated", v, err)
			}
		})
	}
	// The normal variant continues to return no retirement for an unretired
	// scope; adding the field did not change its former classification.
	raw := inspectionEncode(t, inspectionEmptyRecord())
	o, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	if v, err := closedInspectionMetadata(o, scope); err != nil || v.Retirement != nil || v.Revision != 0 {
		t.Fatal("ordinary inspection changed", v, err)
	}
	for _, ctx := range []context.Context{nil, cancelledInterruptedContext()} {
		if l, err := AcquireInterruptedRetirementInspection(ctx, Root{}, scope, inspectionLimits); l != nil || !errors.Is(err, Cancelled) {
			t.Fatal("cancelled input reached IO", err)
		}
	}
	for _, limits := range []Limits{{}, {Bytes: 1024*1024 + 1, Records: 1}, {Bytes: 1024, Records: 4097}} {
		if l, err := AcquireInterruptedRetirementInspection(context.Background(), inspectionFixtureRoot(), scope, limits); l != nil || !errors.Is(err, Invalid) {
			t.Fatal("unbounded input reached IO", err)
		}
	}
}

func cancelledInterruptedContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func TestInterruptedRetirementPureLifecycleLeaseFailureIsSticky(t *testing.T) {
	got, err := interruptedRetirementInspectionMetadata(inspectionEncode(t, interruptedRetirementPureRecord()), inspectionFixtureRoot(), scope, inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	checks, closes := 0, 0
	l := &ClosedLease{value: got, verify: func() error { checks++; return failure(Unavailable, false) }, close: func() error { closes++; return nil }}
	first := l.Verify()
	if first == nil || l.Verify() != first || checks != 1 {
		t.Fatal("failed verification was retried")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("failed lease exposed retirement")
	}
	if l.Close() != nil || l.Close() != nil || closes != 1 {
		t.Fatal("close was retried")
	}
}

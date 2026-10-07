package lifecycle

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// CPU-only canonical fixtures and callback sequencing, not native lock/profile
// evidence. This exact prefix is the only test lane authorized for this writer.
func TestClosedInspectionPureLifecycleClassification(t *testing.T) {
	for _, kind := range []string{"empty-v2", "empty-v3", "empty-successor", "admitted", "retirement", "unknown"} {
		t.Run(kind, func(t *testing.T) {
			r := inspectionEmptyRecord()
			accept := true
			switch kind {
			case "empty-v2":
				r.Version = 2
			case "empty-successor":
				r.Incarnations = []string{"old", scope.BackendGeneration}
			case "admitted":
				r.Writes, accept = []port.JournalWrite{admissionWrite(t)}, false
			case "retirement":
				r.Retirement = &port.RetirementWrite{Scope: scope, Root: fixtureRoot, Revision: 1, Turns: []port.RetirementTurn{}}
				accept = false
			case "unknown":
				r, accept = inspectionUnknownRecord(t), false
			}
			raw := inspectionEncode(t, r)
			observed, err := inspectRecord(raw, inspectionFixtureRoot(), inspectionLimits)
			if err != nil {
				t.Fatal(err)
			}
			got, err := closedInspectionMetadata(observed, scope)
			if accept {
				if err != nil || got.Scope != scope || got.Root != fixtureRoot || got.SnapshotDigest != observed.SnapshotDigest || got.Version != r.Version || got.Revision != 0 || strings.Join(got.Incarnations, ",") != strings.Join(r.Incarnations, ",") {
					t.Fatal("empty metadata differs", got, err)
				}
				got.Incarnations[0] = "changed"
				if observed.Incarnations[0] != r.Incarnations[0] {
					t.Fatal("metadata aliases canonical projection")
				}
				if _, ok := any(got).(port.CleanRetirement); ok {
					t.Fatal("diagnostic became retirement proof")
				}
			} else if !errors.Is(err, Refused) {
				t.Fatal("nonempty/retired journal accepted", err)
			}
			wrong := scope
			wrong.BackendGeneration = "wrong"
			if _, err := closedInspectionMetadata(observed, wrong); !errors.Is(err, Refused) {
				t.Fatal("crossed current scope accepted", err)
			}
		})
	}
	raw := inspectionEncode(t, inspectionEmptyRecord())
	if _, err := inspectRecord(append(raw, ' '), inspectionFixtureRoot(), inspectionLimits); !errors.Is(err, Invalid) {
		t.Fatal("canonical decoder bypassed", err)
	}
	if _, err := closedInspectionMetadata(nil, scope); !errors.Is(err, Refused) {
		t.Fatal("nil projection accepted", err)
	}
}

func TestClosedInspectionPureLifecycleCallbackAndInput(t *testing.T) {
	callbackErr := errors.New("caller stopped")
	for _, kind := range []string{"success", "callback-error", "recheck-error", "cancelled-before", "cancelled-during"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			order := ""
			value := ClosedInspection{Incarnations: []string{"backend"}}
			if kind == "cancelled-before" {
				cancel()
			}
			err := closedInspectionCallback(ctx, value, func() error {
				order += "recheck"
				if kind == "recheck-error" {
					return failure(Unavailable, false)
				}
				return nil
			}, func(v ClosedInspection) error {
				order += "callback/"
				v.Incarnations[0] = "caller"
				if kind == "cancelled-during" {
					cancel()
				}
				if kind == "callback-error" || kind == "recheck-error" {
					return callbackErr
				}
				return nil
			})
			want := error(nil)
			switch kind {
			case "callback-error":
				want = callbackErr
			case "recheck-error":
				want = Unavailable
			case "cancelled-before", "cancelled-during":
				want = Cancelled
			}
			if !errors.Is(err, want) || value.Incarnations[0] != "backend" || kind == "cancelled-before" && order != "" || kind != "cancelled-before" && order != "callback/recheck" {
				t.Fatal("callback/recheck contract differs", order, err)
			}
		})
	}
	// Every case fails before any native IO, even on a supported host.
	if err := WithClosedInspection(context.Background(), Root{}, scope, inspectionLimits, nil); !errors.Is(err, Invalid) {
		t.Fatal("nil callback accepted", err)
	}
	for _, limits := range []Limits{{}, {Bytes: 1024*1024 + 1, Records: 1}, {Bytes: 1024, Records: 4097}} {
		if err := WithClosedInspection(context.Background(), inspectionFixtureRoot(), scope, limits, func(ClosedInspection) error { t.Fatal("invalid input called callback"); return nil }); !errors.Is(err, Invalid) {
			t.Fatal("unbounded input accepted", err)
		}
	}
}

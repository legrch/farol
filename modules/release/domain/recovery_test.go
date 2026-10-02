package release

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestCrashVectors(t *testing.T) {
	// Symbolic fixtures are independent expectations, not persisted native
	// journals, live process observations, or permission/filesystem evidence.
	var vectors []struct {
		Name            string
		Phase           string
		Slot            string
		Staged          string
		Previous        string
		Failed          string
		HelperEnded     bool
		ArchiveVerified bool
		Incomplete      bool
		RestorePending  bool
		Want            string
		Launch          string
	}
	bytes, err := os.ReadFile("testdata/recovery.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(bytes, &vectors); err != nil {
		t.Fatal(err)
	}
	source := Build{Digest: strings.Repeat("a", 64), Version: "0.1.8-owner.beta.1", BuildID: strings.Repeat("b", 64)}
	target := Build{Digest: strings.Repeat("c", 64), Version: "0.1.9-owner.beta.1", BuildID: strings.Repeat("d", 64)}
	op := Operation{ID: strings.Repeat("e", 32), Source: source, Target: target}
	physical := func(symbol string) *Build {
		switch symbol {
		case "", "absent":
			return nil
		case "source":
			b := source
			return &b
		case "target":
			b := target
			return &b
		case "other":
			b := target
			b.Digest = strings.Repeat("f", 64)
			return &b
		default:
			t.Fatalf("invalid fixture symbol %q", symbol)
			return nil
		}
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			o := Observation{Operation: op, Complete: !v.Incomplete, Slot: physical(v.Slot), Staged: physical(v.Staged), Previous: physical(v.Previous), Failed: physical(v.Failed), HelperExited: v.HelperEnded, ArchiveVerified: v.ArchiveVerified, RestorePending: v.RestorePending}
			if v.Phase != "absent" {
				o.Journal = &Journal{Operation: op, Phase: v.Phase}
			}
			got := Assess(o)
			names := []string{"unresolved", "reconcile_preparation", "explicit_recovery", "rollback_available", "settled_source"}
			if names[got.Kind] != v.Want {
				t.Fatalf("got %+v, want %s", got, v.Want)
			}
			launch := []string{"", "unknown", "returned"}[got.Launch]
			if launch != v.Launch {
				t.Fatalf("launch %q, want %q", launch, v.Launch)
			}
			if got.Kind == Unresolved && got.Code == "" {
				t.Fatal("unresolved must retain a classified blocker")
			}
		})
	}
}

func TestHelperEndedNeedsBoundProcessEvidence(t *testing.T) {
	h := &Helper{PID: 42, ProcessStart: "Fri Oct  2 20:00:00 2026"}
	for _, tc := range []struct {
		name   string
		helper *Helper
		obs    ProcessObservation
		want   bool
	}{
		{"no helper", nil, ProcessObservation{PID: 42, State: ProcessAbsent}, false},
		{"different pid", h, ProcessObservation{PID: 43, State: ProcessAbsent}, false},
		{"denied read", h, ProcessObservation{PID: 42, State: ProcessUnknown}, false},
		{"same child", h, ProcessObservation{PID: 42, State: ProcessPresent, ProcessStart: h.ProcessStart}, false},
		{"missing read start", h, ProcessObservation{PID: 42, State: ProcessPresent}, false},
		{"confirmed absent", h, ProcessObservation{PID: 42, State: ProcessAbsent}, true},
		{"pid reused", h, ProcessObservation{PID: 42, State: ProcessPresent, ProcessStart: "later"}, true},
		{"null original start present", &Helper{PID: 42}, ProcessObservation{PID: 42, State: ProcessPresent, ProcessStart: "later"}, false},
		{"null original start absent", &Helper{PID: 42}, ProcessObservation{PID: 42, State: ProcessAbsent}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := HelperEnded(tc.helper, tc.obs); got != tc.want {
				t.Fatalf("ended=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestRecoveryRefusesBindingAndLabelOnlyMatches(t *testing.T) {
	source := Build{Digest: strings.Repeat("a", 64), Version: "1", BuildID: strings.Repeat("b", 64)}
	target := Build{Digest: strings.Repeat("c", 64), Version: "2", BuildID: strings.Repeat("d", 64)}
	op := Operation{ID: strings.Repeat("e", 32), Source: source, Target: target}
	journal := Journal{Operation: op, Phase: "verified"}
	o := Observation{Operation: op, Journal: &journal, Complete: true, Slot: &target, Previous: &source}
	if Assess(o).Kind != RollbackAvailable {
		t.Fatal("fixture baseline")
	}
	changed := journal
	changed.Operation.ID = strings.Repeat("f", 32)
	o.Journal = &changed
	if Assess(o).Kind != Unresolved {
		t.Fatal("accepted crossed operation")
	}
	o.Journal = &journal
	label := target
	label.Digest = strings.Repeat("f", 64)
	o.Slot = &label
	if Assess(o).Kind != Unresolved {
		t.Fatal("accepted version/build labels without measured tree")
	}
	o.Slot = &target
	o.Operation.ID = "bad"
	if Assess(o).Kind != Unresolved {
		t.Fatal("accepted malformed operation")
	}
}

// This compares the accepted settled/interrupted distinction using the same
// measured pair and live helper. It provides policy evidence, not a kernel lease.
func TestSettledObservationDoesNotProveHelperExit(t *testing.T) {
	source := Build{Digest: strings.Repeat("a", 64), Version: "1", BuildID: strings.Repeat("b", 64)}
	target := Build{Digest: strings.Repeat("c", 64), Version: "2", BuildID: strings.Repeat("d", 64)}
	op := Operation{ID: strings.Repeat("e", 32), Source: source, Target: target}
	helper := &Helper{PID: 42, ProcessStart: "same child"}
	ended := HelperEnded(helper, ProcessObservation{PID: 42, State: ProcessPresent, ProcessStart: helper.ProcessStart})
	if ended {
		t.Fatal("live original helper was reported ended")
	}
	journal := Journal{Operation: op, Phase: "launch_requested"}
	o := Observation{Operation: op, Journal: &journal, Complete: true, Slot: &target, Previous: &source, HelperExited: ended}
	if got := Assess(o); got.Kind != RollbackAvailable || got.Launch != LaunchUnknown {
		t.Fatalf("settled observation lost measured predecessor or launch uncertainty: %+v", got)
	}
	journal.Phase = "new_installed"
	if got := Assess(o); got.Kind != Unresolved || got.Code != "UPDATE_HELPER_EXIT_UNCONFIRMED" {
		t.Fatalf("interrupted pair bypassed live helper: %+v", got)
	}
}

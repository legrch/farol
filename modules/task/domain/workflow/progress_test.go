package workflow

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// These are pure portable policy fixtures; they execute no provider or host.
func fixture(count int) Plan {
	plan := Plan{ID: "workflow-1", Parent: Parent{ThreadID: "parent-thread", TurnID: "parent-turn"}}
	for i := range count {
		id := fmt.Sprintf("step-%d", i)
		plan.Steps = append(plan.Steps, Step{ID: id, TaskID: "task-" + id, OperationID: "create-" + id, CancelOperationID: "cancel-" + id, DeliveryOperationID: "deliver-" + id, Required: []Capability{CapabilityCreate}, Output: Output{Kind: OutputText, MaxBytes: 1024}})
	}
	return plan
}

func allCapabilities(slots int) Budget {
	return Budget{Slots: slots, Available: map[Capability]bool{CapabilityCreate: true, CapabilityCancel: true, CapabilityContinue: true, CapabilityResume: true, CapabilityMessage: true}}
}

func TestValidateFinitePlans(t *testing.T) {
	for _, count := range []int{1, 4, 12, MaxSteps} {
		if err := Validate(fixture(count)); err != nil {
			t.Fatalf("count=%d: %v", count, err)
		}
	}
	plan := fixture(3)
	plan.Steps[0].Dependencies = []string{plan.Steps[2].ID}
	plan.Steps[2].Dependencies = []string{plan.Steps[1].ID}
	if err := Validate(plan); err != nil {
		t.Fatalf("declaration order need not be topological: %v", err)
	}
}

func TestValidateRejectsInvalidPlans(t *testing.T) {
	cases := []struct {
		name string
		edit func(*Plan)
	}{
		{"empty plan", func(p *Plan) { p.Steps = nil }},
		{"too many steps", func(p *Plan) { *p = fixture(MaxSteps + 1) }},
		{"missing parent turn", func(p *Plan) { p.Parent.TurnID = "" }},
		{"missing parent thread", func(p *Plan) { p.Parent.ThreadID = "" }},
		{"invalid plan identity", func(p *Plan) { p.ID = "private prompt text" }},
		{"invalid step identity", func(p *Plan) { p.Steps[0].ID = "\x00" }},
		{"invalid task identity", func(p *Plan) { p.Steps[0].TaskID = "" }},
		{"duplicate step", func(p *Plan) { p.Steps[1].ID = p.Steps[0].ID }},
		{"duplicate task", func(p *Plan) { p.Steps[1].TaskID = p.Steps[0].TaskID }},
		{"missing operation", func(p *Plan) { p.Steps[0].OperationID = "" }},
		{"missing cancel operation", func(p *Plan) { p.Steps[0].CancelOperationID = "" }},
		{"missing delivery operation", func(p *Plan) { p.Steps[0].DeliveryOperationID = "" }},
		{"duplicate cross-action operation", func(p *Plan) { p.Steps[1].OperationID = p.Steps[0].DeliveryOperationID }},
		{"duplicate local operation", func(p *Plan) { p.Steps[0].CancelOperationID = p.Steps[0].OperationID }},
		{"missing dependency", func(p *Plan) { p.Steps[0].Dependencies = []string{"missing"} }},
		{"duplicate dependency", func(p *Plan) { p.Steps[0].Dependencies = []string{p.Steps[1].ID, p.Steps[1].ID} }},
		{"self dependency", func(p *Plan) { p.Steps[0].Dependencies = []string{p.Steps[0].ID} }},
		{"cycle", func(p *Plan) {
			p.Steps[0].Dependencies = []string{p.Steps[1].ID}
			p.Steps[1].Dependencies = []string{p.Steps[0].ID}
		}},
		{"indirect cycle", func(p *Plan) {
			p.Steps[0].Dependencies = []string{p.Steps[1].ID}
			p.Steps[1].Dependencies = []string{p.Steps[2].ID}
			p.Steps[2].Dependencies = []string{p.Steps[0].ID}
		}},
		{"unknown capability", func(p *Plan) { p.Steps[0].Required = []Capability{"shell"} }},
		{"duplicate capability", func(p *Plan) { p.Steps[0].Required = []Capability{CapabilityCreate, CapabilityCreate} }},
		{"too many capabilities", func(p *Plan) { p.Steps[0].Required = make([]Capability, 6) }},
		{"unknown output type", func(p *Plan) { p.Steps[0].Output.Kind = "binary" }},
		{"zero output allowance", func(p *Plan) { p.Steps[0].Output.MaxBytes = 0 }},
		{"negative output allowance", func(p *Plan) { p.Steps[0].Output.MaxBytes = -1 }},
		{"excess output allowance", func(p *Plan) { p.Steps[0].Output.MaxBytes = MaxOutputBytes + 1 }},
		{"too many edges", func(p *Plan) { p.Steps[0].Dependencies = make([]string, MaxEdges+1) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := fixture(3)
			tc.edit(&plan)
			if err := Validate(plan); err == nil {
				t.Fatal("malformed plan accepted")
			}
			if got := Ready(plan, nil, allCapabilities(12)); len(got) != 0 {
				t.Fatalf("malformed plan scheduled: %v", got)
			}
		})
	}
}

func TestIdentityMetadata(t *testing.T) {
	for _, good := range []string{"a", "TASK:thread/turn-01_foo.bar", strings.Repeat("a", MaxIDBytes)} {
		if !ID(good) {
			t.Fatalf("valid metadata rejected: %q", good)
		}
	}
	for _, bad := range []string{"", "a b", "a\n", "a\t", "a\x00", "caf\u00e9", strings.Repeat("a", MaxIDBytes+1)} {
		if ID(bad) {
			t.Fatalf("invalid metadata accepted: %q", bad)
		}
	}
}

func TestFanoutBudgetAndOrder(t *testing.T) {
	for _, count := range []int{1, 4, 12} {
		for _, slots := range []int{0, 1, 4, 12} {
			plan := fixture(count)
			got := Ready(plan, nil, allCapabilities(slots))
			want := min(count, slots)
			if len(got) != want {
				t.Fatalf("count=%d slots=%d: ready=%v", count, slots, got)
			}
			for i, id := range got {
				if id != plan.Steps[i].ID {
					t.Fatalf("count=%d slots=%d: order=%v", count, slots, got)
				}
			}
		}
	}
}

func TestAggregationRequiresAcceptedCompletions(t *testing.T) {
	plan := fixture(3)
	plan.Steps[2].Dependencies = []string{plan.Steps[0].ID, plan.Steps[1].ID}
	outcomes := map[string]Outcome{plan.Steps[0].ID: {State: Completed, Accepted: true}, plan.Steps[1].ID: {State: Running}}
	if got := Ready(plan, outcomes, allCapabilities(3)); len(got) != 0 {
		t.Fatalf("aggregation started early: %v", got)
	}
	for _, state := range []State{Waiting, Failed, NeedsInput, Cancelled, Unknown, Unavailable, InvalidOutput, Completed} {
		outcomes[plan.Steps[1].ID] = Outcome{State: state}
		got := Ready(plan, outcomes, allCapabilities(3))
		for _, id := range got {
			if id == plan.Steps[2].ID {
				t.Fatalf("aggregation consumes unaccepted %s", state)
			}
		}
	}
	outcomes[plan.Steps[1].ID] = Outcome{State: Completed, Accepted: true}
	if got := Ready(plan, outcomes, allCapabilities(3)); !reflect.DeepEqual(got, []string{plan.Steps[2].ID}) {
		t.Fatalf("accepted dependencies did not release aggregation: %v", got)
	}
}

func TestBlockedStepsDoNotStarveIndependentWork(t *testing.T) {
	plan := fixture(5)
	plan.Steps[2].Dependencies = []string{plan.Steps[0].ID}
	plan.Steps[3].Required = []Capability{CapabilityCreate, CapabilityResume}
	outcomes := map[string]Outcome{plan.Steps[0].ID: {State: NeedsInput}, plan.Steps[1].ID: {State: Unavailable}}
	budget := allCapabilities(1)
	budget.Available[CapabilityResume] = false
	if got := Ready(plan, outcomes, budget); !reflect.DeepEqual(got, []string{plan.Steps[4].ID}) {
		t.Fatalf("blocked earlier work starved independent step: %v", got)
	}
}

func TestUnknownAndRunningOccupyCapacityWithoutRedispatch(t *testing.T) {
	plan := fixture(4)
	outcomes := map[string]Outcome{plan.Steps[0].ID: {State: Unknown}, plan.Steps[1].ID: {State: Running}}
	if got := Ready(plan, outcomes, allCapabilities(2)); len(got) != 0 {
		t.Fatalf("occupied budget dispatched work: %v", got)
	}
	want := []string{plan.Steps[2].ID}
	for range 3 {
		if got := Ready(plan, outcomes, allCapabilities(3)); !reflect.DeepEqual(got, want) {
			t.Fatalf("ambiguous/running operation selected or capacity lost: %v", got)
		}
	}
	outcomes[plan.Steps[0].ID] = Outcome{State: Completed, Accepted: true}
	if got := Ready(plan, outcomes, allCapabilities(2)); !reflect.DeepEqual(got, want) {
		t.Fatalf("settled unknown did not release slot: %v", got)
	}
}

func TestPauseClosureCancellationAndCreateCapability(t *testing.T) {
	plan := fixture(2)
	for _, budget := range []Budget{{Slots: -1}, {Slots: 0}, {Slots: 2, Paused: true}, {Slots: 2, ParentClosed: true}, {Slots: 2}} {
		if got := Ready(plan, nil, budget); len(got) != 0 {
			t.Fatalf("closed/paused/unavailable budget selected: %v", got)
		}
	}
	outcomes := map[string]Outcome{plan.Steps[0].ID: {State: Waiting, CancelRequested: true}}
	if got := Ready(plan, outcomes, allCapabilities(2)); !reflect.DeepEqual(got, []string{plan.Steps[1].ID}) {
		t.Fatalf("cancel-requested waiting step admitted: %v", got)
	}
	plan.Steps[0].Required = nil
	budget := allCapabilities(2)
	budget.Available[CapabilityCreate] = false
	if got := Ready(plan, nil, budget); len(got) != 0 {
		t.Fatalf("implicit Create capability bypassed: %v", got)
	}
}

func TestOutcomeValidationAndProjection(t *testing.T) {
	plan := fixture(2)
	for _, bad := range []map[string]Outcome{
		{"foreign": {State: Completed, Accepted: true}},
		{plan.Steps[0].ID: {}},
		{plan.Steps[0].ID: {State: "delivered"}},
		{plan.Steps[0].ID: {State: Waiting, Accepted: true}},
		{plan.Steps[0].ID: {State: Failed, Accepted: true}},
	} {
		if ValidateOutcomes(plan, bad) == nil {
			t.Fatalf("bad outcomes accepted: %v", bad)
		}
		if got := Ready(plan, bad, allCapabilities(2)); len(got) != 0 {
			t.Fatalf("corrupt progress scheduled: %v", got)
		}
		if _, err := Project(plan, bad); err == nil {
			t.Fatal("corrupt progress projected")
		}
	}
	for _, state := range []State{Waiting, Running, Completed, Failed, NeedsInput, Cancelled, Unknown, Unavailable, InvalidOutput} {
		if err := ValidateOutcomes(plan, map[string]Outcome{plan.Steps[0].ID: {State: state}}); err != nil {
			t.Fatalf("known state %s rejected: %v", state, err)
		}
	}
	outcomes := map[string]Outcome{plan.Steps[1].ID: {State: Completed, Accepted: true, CancelRequested: true}}
	got, err := Project(plan, outcomes)
	if err != nil {
		t.Fatal(err)
	}
	want := []StepProgress{{StepID: plan.Steps[0].ID, TaskID: plan.Steps[0].TaskID, State: Waiting}, {StepID: plan.Steps[1].ID, TaskID: plan.Steps[1].TaskID, State: Completed, Accepted: true, CancelRequested: true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("projection: got=%v want=%v", got, want)
	}
}

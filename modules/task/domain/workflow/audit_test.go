package workflow

import (
	"reflect"
	"strings"
	"testing"
)

// This audit exercises pure, portable graph boundaries. It makes no provider,
// journal, runtime admission, native-host, or production qualification claim.
func TestAuditExactDependencyBudget(t *testing.T) {
	plan := fixture(MaxSteps)
	remaining := MaxEdges
	for i := 1; i < len(plan.Steps) && remaining > 0; i++ {
		for j := 0; j < i && remaining > 0; j++ {
			plan.Steps[i].Dependencies = append(plan.Steps[i].Dependencies, plan.Steps[j].ID)
			remaining--
		}
	}
	if remaining != 0 {
		t.Fatal("fixture could not reach the declared dependency budget")
	}
	if err := Validate(plan); err != nil {
		t.Fatalf("valid DAG at exactly MaxEdges rejected: %v", err)
	}
	// Add a real, unique backward edge: overflow cannot be masked by an
	// invalid reference, repeated edge, or cycle in this fixture.
	last := &plan.Steps[len(plan.Steps)-1]
	if len(last.Dependencies) != 0 {
		t.Fatal("overflow fixture unexpectedly populated the final node")
	}
	last.Dependencies = []string{plan.Steps[0].ID}
	if err := Validate(plan); err == nil || !strings.Contains(err.Error(), "dependency count exceeds") {
		t.Fatalf("MaxEdges+1 did not fail at the graph budget: %v", err)
	}
	if got := Ready(plan, nil, allCapabilities(MaxSteps)); len(got) != 0 {
		t.Fatalf("oversized valid-reference graph scheduled: %v", got)
	}
}

func TestAuditMaximalForwardReferenceChain(t *testing.T) {
	plan := fixture(MaxSteps)
	for i := 0; i+1 < len(plan.Steps); i++ {
		plan.Steps[i].Dependencies = []string{plan.Steps[i+1].ID}
	}
	if err := Validate(plan); err != nil {
		t.Fatalf("MaxSteps-deep forward-reference chain rejected: %v", err)
	}
	root := plan.Steps[len(plan.Steps)-1].ID
	if got := Ready(plan, nil, allCapabilities(MaxSteps)); !reflect.DeepEqual(got, []string{root}) {
		t.Fatalf("deep chain admitted anything beyond its sole root: %v", got)
	}
	completed := make(map[string]Outcome, MaxSteps-1)
	for _, step := range plan.Steps[1:] {
		completed[step.ID] = Outcome{State: Completed, Accepted: true}
	}
	if got := Ready(plan, completed, allCapabilities(MaxSteps)); !reflect.DeepEqual(got, []string{plan.Steps[0].ID}) {
		t.Fatalf("restored deep chain reran completed work or lost final aggregation: %v", got)
	}
	plan.Steps[len(plan.Steps)-1].Dependencies = []string{plan.Steps[0].ID}
	if err := Validate(plan); err == nil || !strings.Contains(err.Error(), "cyclic") {
		t.Fatalf("MaxSteps-deep closing cycle accepted: %v", err)
	}
}

func TestAuditDisconnectedInvalidComponentsBlockAdmission(t *testing.T) {
	cases := []struct {
		name string
		edit func(*Plan)
	}{
		{"unreachable cycle", func(p *Plan) {
			p.Steps[4].Dependencies = []string{p.Steps[5].ID}
			p.Steps[5].Dependencies = []string{p.Steps[6].ID}
			p.Steps[6].Dependencies = []string{p.Steps[4].ID}
		}},
		{"missing terminal dependency", func(p *Plan) { p.Steps[6].Dependencies = []string{"unlisted-final-node"} }},
		{"empty dependency identity", func(p *Plan) { p.Steps[6].Dependencies = []string{""} }},
		{"non-ASCII dependency identity", func(p *Plan) { p.Steps[6].Dependencies = []string{"step-\u00e9"} }},
		{"control in dependency identity", func(p *Plan) { p.Steps[6].Dependencies = []string{"step-\x00"} }},
		{"overlong dependency identity", func(p *Plan) { p.Steps[6].Dependencies = []string{strings.Repeat("x", MaxIDBytes+1)} }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := fixture(7)
			// An unrelated, initially ready root and a healthy component precede
			// the invalid component. Whole-plan validation must fail before any
			// root is admitted, even with a one-slot budget.
			plan.Steps[2].Dependencies = []string{plan.Steps[1].ID}
			plan.Steps[3].Dependencies = []string{plan.Steps[2].ID}
			tc.edit(&plan)
			if err := Validate(plan); err == nil {
				t.Fatal("invalid disconnected component accepted")
			}
			if got := Ready(plan, nil, allCapabilities(1)); len(got) != 0 {
				t.Fatalf("ready unrelated root escaped invalid-plan fence: %v", got)
			}
		})
	}
}

func TestAuditReadyOrderIgnoresOutcomeMapInsertion(t *testing.T) {
	plan := fixture(8)
	original := append([]Step(nil), plan.Steps...)
	for i, index := range []int{7, 2, 4, 0, 6, 1, 5, 3} {
		plan.Steps[i] = original[index]
	}
	plan.Steps[0].Dependencies = []string{original[3].ID}
	plan.Steps[2].Dependencies = []string{original[1].ID}
	plan.Steps[6].Dependencies = []string{original[3].ID}
	entries := []struct {
		id      string
		outcome Outcome
	}{
		{original[2].ID, Outcome{State: Running}},
		{original[6].ID, Outcome{State: Unknown}},
		{original[3].ID, Outcome{State: Completed, Accepted: true}},
		{original[1].ID, Outcome{State: NeedsInput}},
	}
	checks := 0
	var permute func(int)
	permute = func(at int) {
		if at < len(entries) {
			for i := at; i < len(entries); i++ {
				entries[at], entries[i] = entries[i], entries[at]
				permute(at + 1)
				entries[at], entries[i] = entries[i], entries[at]
			}
			return
		}
		outcomes := make(map[string]Outcome, len(entries))
		for _, entry := range entries {
			outcomes[entry.id] = entry.outcome
		}
		for _, slots := range []int{2, 4, 5} {
			want := []string{original[7].ID, original[0].ID, original[5].ID}[:slots-2]
			got := Ready(plan, outcomes, allCapabilities(slots))
			if len(got) != len(want) || len(want) > 0 && !reflect.DeepEqual(got, want) {
				t.Fatalf("slots=%d insertion=%v: got=%v want=%v", slots, entries, got, want)
			}
		}
		checks++
	}
	permute(0)
	if checks != 24 {
		t.Fatalf("incomplete insertion-order audit: %d", checks)
	}
}

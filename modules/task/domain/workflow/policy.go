package workflow

import "fmt"

type State string

const (
	Waiting       State = "waiting"
	Running       State = "running"
	Completed     State = "completed"
	Failed        State = "failed"
	NeedsInput    State = "needs_input"
	Cancelled     State = "cancelled"
	Unknown       State = "unknown"
	Unavailable   State = "unavailable"
	InvalidOutput State = "invalid_output"
)

func (s State) Valid() bool {
	return s == Waiting || s == Running || s == Completed || s == Failed || s == NeedsInput || s == Cancelled || s == Unknown || s == Unavailable || s == InvalidOutput
}

type Outcome struct {
	State           State
	Accepted        bool
	CancelRequested bool
}

type Budget struct {
	Slots                int
	Paused, ParentClosed bool
	Available            map[Capability]bool
}

// ValidateOutcomes rejects corrupt or foreign progress before scheduling. An
// absent map entry is Waiting; an explicitly recorded entry needs a known state.
func ValidateOutcomes(plan Plan, outcomes map[string]Outcome) error {
	if err := Validate(plan); err != nil {
		return err
	}
	known := make(map[string]bool, len(plan.Steps))
	for _, step := range plan.Steps {
		known[step.ID] = true
	}
	for id, outcome := range outcomes {
		if !known[id] || !outcome.State.Valid() || (outcome.Accepted && outcome.State != Completed) {
			return fmt.Errorf("workflow: invalid outcome for step %s", id)
		}
	}
	return nil
}

// Ready chooses new Create operations only. It grants no authority and makes no
// effects. Ambiguous execution occupies capacity until original observation
// resolves it, and is never selected again. Approval holds occupy no capacity.
func Ready(plan Plan, outcomes map[string]Outcome, budget Budget) []string {
	if budget.Slots <= 0 || budget.Paused || budget.ParentClosed || ValidateOutcomes(plan, outcomes) != nil {
		return nil
	}
	remaining := budget.Slots
	for _, outcome := range outcomes {
		if outcome.State == Running || outcome.State == Unknown {
			remaining--
		}
	}
	if remaining <= 0 {
		return nil
	}
	var ready []string
	for _, step := range plan.Steps {
		outcome, recorded := outcomes[step.ID]
		if (recorded && outcome.State != Waiting) || outcome.CancelRequested {
			continue
		}
		eligible := budget.Available[CapabilityCreate]
		for _, capability := range step.Required {
			eligible = eligible && budget.Available[capability]
		}
		for _, dependency := range step.Dependencies {
			observed := outcomes[dependency]
			eligible = eligible && observed.State == Completed && observed.Accepted
		}
		if !eligible {
			continue
		}
		ready = append(ready, step.ID)
		remaining--
		if remaining == 0 {
			break
		}
	}
	return ready
}

// StepProgress is a content-free view. Completed and accepted output are
// distinct; delivery and provider identities are projected by the app owner.
type StepProgress struct {
	StepID, TaskID  string
	State           State
	Accepted        bool
	CancelRequested bool
}

func Project(plan Plan, outcomes map[string]Outcome) ([]StepProgress, error) {
	if err := ValidateOutcomes(plan, outcomes); err != nil {
		return nil, err
	}
	progress := make([]StepProgress, 0, len(plan.Steps))
	for _, step := range plan.Steps {
		outcome, exists := outcomes[step.ID]
		if !exists {
			outcome.State = Waiting
		}
		progress = append(progress, StepProgress{StepID: step.ID, TaskID: step.TaskID, State: outcome.State, Accepted: outcome.Accepted, CancelRequested: outcome.CancelRequested})
	}
	return progress, nil
}

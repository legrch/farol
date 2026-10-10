// Package workflow provides bounded, finite coordination policy. Task remains
// responsible for durable effects, admission, execution, and delivery.
package workflow

import "fmt"

const (
	MaxSteps       = 128
	MaxEdges       = 1024
	MaxIDBytes     = 128
	MaxOutputBytes = 65536
)

type Capability string

const (
	CapabilityCreate   Capability = "create"
	CapabilityCancel   Capability = "cancel"
	CapabilityContinue Capability = "continue"
	CapabilityResume   Capability = "resume"
	CapabilityMessage  Capability = "message"
)

func (c Capability) Valid() bool {
	return c == CapabilityCreate || c == CapabilityCancel || c == CapabilityContinue || c == CapabilityResume || c == CapabilityMessage
}

type OutputKind string

const (
	OutputText OutputKind = "text"
	OutputJSON OutputKind = "json"
)

type Output struct {
	Kind     OutputKind
	MaxBytes int
}

type Parent struct{ ThreadID, TurnID string }

type Step struct {
	ID, TaskID, OperationID, CancelOperationID, DeliveryOperationID string
	Dependencies                                                    []string
	Required                                                        []Capability
	Output                                                          Output
}

type Plan struct {
	ID     string
	Parent Parent
	Steps  []Step
}

// Clone separates step metadata from consumer callbacks. Strings and the other
// fields are values; only dependencies and capabilities need independent slices.
func (s Step) Clone() Step {
	s.Dependencies = append([]string(nil), s.Dependencies...)
	s.Required = append([]Capability(nil), s.Required...)
	return s
}

// Capture takes a bounded, validated snapshot before calling any external port.
// The caller must synchronize access until this synchronous capture returns;
// later caller/port mutations cannot change the captured identity or policy.
// It is an in-call value snapshot, not durable workflow state or activation.
func Capture(plan Plan) (Plan, error) {
	if len(plan.Steps) == 0 || len(plan.Steps) > MaxSteps {
		return Plan{}, fmt.Errorf("workflow: step count must be 1..%d", MaxSteps)
	}
	edges := 0
	for _, step := range plan.Steps {
		if len(step.Dependencies) > MaxEdges-edges || len(step.Required) > 5 {
			return Plan{}, fmt.Errorf("workflow: capture exceeds metadata bounds")
		}
		edges += len(step.Dependencies)
	}
	out := plan
	out.Steps = make([]Step, len(plan.Steps))
	for i, step := range plan.Steps {
		out.Steps[i] = step.Clone()
	}
	if err := Validate(out); err != nil {
		return Plan{}, err
	}
	return out, nil
}

// ID accepts short ASCII identity metadata, never prompts or transcripts.
func ID(s string) bool {
	if len(s) == 0 || len(s) > MaxIDBytes {
		return false
	}
	for i := range s {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':' || c == '/') {
			return false
		}
	}
	return true
}

// Validate rejects malformed identities and graphs before any Task effect.
// Every step creates one distinct Task; auxiliary operation identities are also
// bound up front so cancel and delivery never need an invented retry identity.
func Validate(plan Plan) error {
	if !ID(plan.ID) || !ID(plan.Parent.ThreadID) || !ID(plan.Parent.TurnID) {
		return fmt.Errorf("workflow: invalid plan or parent identity")
	}
	if len(plan.Steps) == 0 || len(plan.Steps) > MaxSteps {
		return fmt.Errorf("workflow: step count must be 1..%d", MaxSteps)
	}
	steps := make(map[string]int, len(plan.Steps))
	tasks := make(map[string]bool, len(plan.Steps))
	operations := make(map[string]bool, len(plan.Steps)*3)
	edges := 0
	for i, step := range plan.Steps {
		if !ID(step.ID) || !ID(step.TaskID) {
			return fmt.Errorf("workflow: invalid step or task identity at index %d", i)
		}
		if _, exists := steps[step.ID]; exists {
			return fmt.Errorf("workflow: duplicate step %s", step.ID)
		}
		steps[step.ID] = i
		if tasks[step.TaskID] {
			return fmt.Errorf("workflow: duplicate task %s", step.TaskID)
		}
		tasks[step.TaskID] = true
		for _, operation := range []string{step.OperationID, step.CancelOperationID, step.DeliveryOperationID} {
			if !ID(operation) || operations[operation] {
				return fmt.Errorf("workflow: invalid or duplicate operation for step %s", step.ID)
			}
			operations[operation] = true
		}
		if (step.Output.Kind != OutputText && step.Output.Kind != OutputJSON) || step.Output.MaxBytes <= 0 || step.Output.MaxBytes > MaxOutputBytes {
			return fmt.Errorf("workflow: invalid output expectation for step %s", step.ID)
		}
		if len(step.Required) > 5 {
			return fmt.Errorf("workflow: too many required capabilities for step %s", step.ID)
		}
		capabilities := make(map[Capability]bool, len(step.Required))
		for _, capability := range step.Required {
			if !capability.Valid() || capabilities[capability] {
				return fmt.Errorf("workflow: invalid or duplicate capability for step %s", step.ID)
			}
			capabilities[capability] = true
		}
		edges += len(step.Dependencies)
		if edges > MaxEdges {
			return fmt.Errorf("workflow: dependency count exceeds %d", MaxEdges)
		}
	}
	for _, step := range plan.Steps {
		seen := make(map[string]bool, len(step.Dependencies))
		for _, dependency := range step.Dependencies {
			if _, exists := steps[dependency]; !exists || dependency == step.ID || seen[dependency] {
				return fmt.Errorf("workflow: missing, self, or duplicate dependency for step %s", step.ID)
			}
			seen[dependency] = true
		}
	}
	// The bounded graph permits a simple deterministic depth-first cycle check.
	marks := make([]uint8, len(plan.Steps))
	var visit func(int) bool
	visit = func(i int) bool {
		if marks[i] == 1 {
			return false
		}
		if marks[i] == 2 {
			return true
		}
		marks[i] = 1
		for _, dependency := range plan.Steps[i].Dependencies {
			if !visit(steps[dependency]) {
				return false
			}
		}
		marks[i] = 2
		return true
	}
	for i := range plan.Steps {
		if !visit(i) {
			return fmt.Errorf("workflow: cyclic dependency graph")
		}
	}
	return nil
}

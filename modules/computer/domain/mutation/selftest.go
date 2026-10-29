package mutation

// SelfTestBinding is durable correlation, not authority to access a workspace.
// Version fixes the derivation of all child operation IDs for the original run.
type SelfTestBinding struct {
	Identity           Identity
	WorkspaceID        string
	ComputerGeneration uint64
	Version            uint8
}

func (b SelfTestBinding) Valid() bool {
	return ValidIdentity(b.Identity) && b.Identity.Scope == ScopeOwnerSettings && ScratchLeaf(ScratchPath(b.Identity.OperationID)) && Identifier(b.WorkspaceID, 120) && b.ComputerGeneration <= MaxSafeInteger && (b.Version == 1 || b.Version == 2 || b.Version == 3)
}

type SelfTestStep struct {
	Name, Status, Code, Operation              string
	Handle, CancelOperation, DescendantCleanup string
}

type SelfTestResult struct {
	Status string
	Steps  []SelfTestStep
}

// Valid bounds content-free facts. Neither a name nor an operation ID grants
// permission to execute or observe a child under current authority.
func (r SelfTestResult) Valid() bool {
	if r.Status != "partial" && r.Status != "failed" && r.Status != "unknown" {
		return false
	}
	if len(r.Steps) > 16 {
		return false
	}
	for _, s := range r.Steps {
		if (s.Status != "pass" && s.Status != "fail" && s.Status != "unknown" && s.Status != "not_tested") || (s.Code != "" && !selfTestToken(s.Code, 160)) || (s.Operation != "" && !selfTestToken(s.Operation, 160)) || (s.Handle != "" && !selfTestToken(s.Handle, 160)) || (s.CancelOperation != "" && !selfTestToken(s.CancelOperation, 160)) {
			return false
		}
		if s.DescendantCleanup != "" && s.DescendantCleanup != "confirmed" && s.DescendantCleanup != "unverified" && s.DescendantCleanup != "pending" {
			return false
		}
	}
	return true
}

func selfTestToken(value string, max int) bool {
	if len(value) == 0 || len(value) > max {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (r SelfTestResult) bound(binding SelfTestBinding) bool {
	if binding.Version == 3 {
		return r.boundV3(binding)
	}
	if binding.Version == 2 {
		return r.boundV2(binding)
	}
	names := []string{"scratch", "write", "edit", "mutation read", "cleanup", "shell", "shell cancel", "workspace reads", "git and hooks"}
	operations := []string{binding.Identity.OperationID, binding.Identity.OperationID + "-st1-write", binding.Identity.OperationID + "-st1-edit", binding.Identity.OperationID + "-st1-edit", binding.Identity.OperationID, binding.Identity.OperationID + "-st1-quick", binding.Identity.OperationID + "-st1-cancel", "", ""}
	if len(r.Steps) > len(names) {
		return false
	}
	for i, s := range r.Steps {
		if s.Name != names[i] || s.Operation != operations[i] {
			return false
		}
		if i < 6 && s.CancelOperation != "" {
			return false
		}
		if i == 6 && s.CancelOperation != "" && s.CancelOperation != binding.Identity.OperationID+"-st1-cancel-op" {
			return false
		}
		if i < 5 && (s.Handle != "" || s.DescendantCleanup != "") {
			return false
		}
		if i >= 7 && (s.Status != "not_tested" || s.Code != "" || s.Handle != "" || s.CancelOperation != "" || s.DescendantCleanup != "") {
			return false
		}
		if i < len(r.Steps)-1 && i < 7 && s.Status != "pass" {
			return false
		}
	}
	if r.Status == "partial" {
		return len(r.Steps) == len(names)
	}
	if len(r.Steps) == 0 {
		return r.Status == "unknown"
	}
	last := r.Steps[len(r.Steps)-1]
	return r.Status == "failed" && last.Status == "fail" || r.Status == "unknown" && (last.Status == "unknown" || last.Status == "pass")
}

// Version 3 checks directory traversal while the scratch fixture is retained.
// Earlier records keep their original version and ordering.
func (r SelfTestResult) boundV3(binding SelfTestBinding) bool {
	id := binding.Identity.OperationID
	names := []string{"scratch", "write", "edit", "mutation read", "catalogue", "bootstrap", "list", "read", "search", "directory search", "cleanup", "shell", "shell cancel", "git and hooks"}
	operations := []string{id, id + "-st3-write", id + "-st3-edit", id + "-st3-edit", id + "-st3-catalogue", id + "-st3-bootstrap", id + "-st3-list", id + "-st3-read", id + "-st3-search", id + "-st3-directory-search", id, id + "-st3-quick", id + "-st3-cancel", ""}
	if len(r.Steps) > len(names) {
		return false
	}
	readFailure := false
	for i, s := range r.Steps {
		if s.Name != names[i] || s.Operation != operations[i] {
			return false
		}
		if i != 12 && s.CancelOperation != "" || i == 12 && s.CancelOperation != "" && s.CancelOperation != id+"-st3-cancel-op" {
			return false
		}
		if i != 11 && i != 12 && (s.Handle != "" || s.DescendantCleanup != "") {
			return false
		}
		if i == 13 && (s.Status != "not_tested" || s.Code != "") {
			return false
		}
		if i < len(r.Steps)-1 && i < 13 {
			if !readFailure && i >= 4 && i <= 9 && s.Status == "fail" {
				readFailure = true
			} else if readFailure && i >= 4 && i <= 9 {
				if s.Status != "not_tested" || s.Code != "" {
					return false
				}
			} else if s.Status != "pass" {
				return false
			}
		}
	}
	if readFailure {
		if len(r.Steps) != 11 {
			return false
		}
		cleanup := r.Steps[10].Status
		return r.Status == "failed" && (cleanup == "pass" || cleanup == "fail") || r.Status == "unknown" && cleanup == "unknown"
	}
	if r.Status == "partial" {
		return len(r.Steps) == len(names)
	}
	if len(r.Steps) == 0 {
		return r.Status == "unknown"
	}
	last := r.Steps[len(r.Steps)-1]
	return r.Status == "failed" && last.Status == "fail" || r.Status == "unknown" && (last.Status == "unknown" || last.Status == "pass")
}

// Version 1 records keep their original interpretation. Version 2 records
// individual read checks before cleanup and never carry their data contents.
func (r SelfTestResult) boundV2(binding SelfTestBinding) bool {
	// Accept the original v2 partial record without rewriting it. That plan
	// predates the explicit directory-search coverage marker.
	if r.Status == "partial" && len(r.Steps) == 13 && r.Steps[12].Name == "git and hooks" {
		steps := append([]SelfTestStep(nil), r.Steps[:12]...)
		steps = append(steps, SelfTestStep{Name: "directory search", Status: "not_tested"}, r.Steps[12])
		return (SelfTestResult{Status: r.Status, Steps: steps}).boundV2(binding)
	}
	id := binding.Identity.OperationID
	names := []string{"scratch", "write", "edit", "mutation read", "catalogue", "bootstrap", "list", "read", "search", "cleanup", "shell", "shell cancel", "directory search", "git and hooks"}
	operations := []string{id, id + "-st2-write", id + "-st2-edit", id + "-st2-edit", id + "-st2-catalogue", id + "-st2-bootstrap", id + "-st2-list", id + "-st2-read", id + "-st2-search", id, id + "-st2-quick", id + "-st2-cancel", "", ""}
	if len(r.Steps) > len(names) {
		return false
	}
	readFailure := false
	for i, s := range r.Steps {
		if s.Name != names[i] || s.Operation != operations[i] {
			return false
		}
		if i != 11 && s.CancelOperation != "" || i == 11 && s.CancelOperation != "" && s.CancelOperation != id+"-st2-cancel-op" {
			return false
		}
		if i != 10 && i != 11 && (s.Handle != "" || s.DescendantCleanup != "") {
			return false
		}
		if i >= 12 && (s.Status != "not_tested" || s.Code != "") {
			return false
		}
		if i < len(r.Steps)-1 && i < 12 {
			if !readFailure && i >= 4 && i <= 8 && s.Status == "fail" {
				readFailure = true
			} else if readFailure && i >= 4 && i <= 8 {
				if s.Status != "not_tested" || s.Code != "" {
					return false
				}
			} else if s.Status != "pass" {
				return false
			}
		}
	}
	if readFailure {
		if len(r.Steps) != 10 {
			return false
		}
		cleanup := r.Steps[9].Status
		return r.Status == "failed" && (cleanup == "pass" || cleanup == "fail") || r.Status == "unknown" && cleanup == "unknown"
	}
	if r.Status == "partial" {
		return len(r.Steps) == len(names)
	}
	if len(r.Steps) == 0 {
		return r.Status == "unknown"
	}
	last := r.Steps[len(r.Steps)-1]
	return r.Status == "failed" && last.Status == "fail" || r.Status == "unknown" && (last.Status == "unknown" || last.Status == "pass")
}

type SelfTestState struct {
	binding SelfTestBinding
	phase   Phase
	result  *SelfTestResult
}

func (s SelfTestState) Binding() SelfTestBinding { return s.binding }
func (s SelfTestState) Phase() Phase             { return s.phase }
func (s SelfTestState) Result() *SelfTestResult {
	if s.result == nil {
		return nil
	}
	r := *s.result
	r.Steps = append([]SelfTestStep(nil), r.Steps...)
	return &r
}

// Prepared observed after interruption remains unknown; it never authorizes
// another execution. Terminal result is write-once, including unknown.
func RestoreSelfTest(binding SelfTestBinding, phase Phase, result *SelfTestResult) (*SelfTestState, error) {
	valid := binding.Valid()
	switch phase {
	case Prepared:
		valid = valid && result == nil
	case Completed:
		valid = valid && result != nil && result.Valid() && result.bound(binding) && result.Status == "partial"
	case Failed:
		valid = valid && result != nil && result.Valid() && result.bound(binding) && result.Status == "failed"
	case OutcomeUnknown:
		valid = valid && result != nil && result.Valid() && result.bound(binding) && result.Status == "unknown"
	default:
		valid = false
	}
	if !valid {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	s := &SelfTestState{binding: binding, phase: phase}
	if result != nil {
		r := *result
		r.Steps = append([]SelfTestStep(nil), result.Steps...)
		s.result = &r
	}
	return s, nil
}

func (s SelfTestState) Apply(next SelfTestState) (*SelfTestState, error) {
	if _, err := RestoreSelfTest(s.binding, s.phase, s.result); err != nil {
		return nil, err
	}
	copy, err := RestoreSelfTest(next.binding, next.phase, next.result)
	if err != nil {
		return nil, err
	}
	if s.binding != next.binding {
		return nil, stateError("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	if s.phase != Prepared || next.phase == Prepared {
		return nil, stateError("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	}
	return copy, nil
}

package mutation

// ScratchFileCleanupState represents one cleanup with one exact file inventory.
// It does not establish a durable admission, current authority or native fd
// custody; those are independent owners and remain required for any effect.
type ScratchFileCleanupState struct {
	inventory ScratchFileInventory
	phase     Phase
	failure   *Failure
}

func (s ScratchFileCleanupState) Inventory() ScratchFileInventory { return s.inventory }
func (s ScratchFileCleanupState) Phase() Phase                    { return s.phase }
func (s ScratchFileCleanupState) Failure() *Failure {
	if s.failure == nil {
		return nil
	}
	copy := *s.failure
	return &copy
}

func RestoreScratchFileCleanup(inventory ScratchFileInventory, phase Phase, f *Failure) (*ScratchFileCleanupState, error) {
	valid := inventory.Valid()
	switch phase {
	case Prepared, Completed:
		valid = valid && f == nil
	case Failed:
		valid = valid && f != nil && f.Directory == (DirectoryIdentity{}) && validFailure(*f, false)
	case OutcomeUnknown:
		valid = valid && f != nil && f.Directory == (DirectoryIdentity{}) && validFailure(*f, true)
	default:
		valid = false
	}
	if !valid {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	s := &ScratchFileCleanupState{inventory: inventory, phase: phase}
	if f != nil {
		copy := *f
		s.failure = &copy
	}
	return s, nil
}

// Apply only retains the same original inventory and a single terminal result.
// A restored Prepared or UNKNOWN value is observation, never a retry permit.
func (s ScratchFileCleanupState) Apply(next ScratchFileCleanupState) (*ScratchFileCleanupState, error) {
	if _, err := RestoreScratchFileCleanup(s.inventory, s.phase, s.failure); err != nil {
		return nil, err
	}
	copy, err := RestoreScratchFileCleanup(next.inventory, next.phase, next.failure)
	if err != nil {
		return nil, err
	}
	if s.inventory != next.inventory {
		return nil, stateError("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	if s.phase == next.phase && (s.failure == nil && next.failure == nil || s.failure != nil && next.failure != nil && *s.failure == *next.failure) {
		return copy, nil
	}
	if s.phase != Prepared || next.phase == Prepared {
		return nil, stateError("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	}
	return copy, nil
}

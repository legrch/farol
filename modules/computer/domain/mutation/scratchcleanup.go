package mutation

// ScratchCleanupBinding records the exact original creation and native
// directory identity. It is correlation evidence, not deletion authority.
// The repository must derive one key in a separate namespace from the original
// creation identity, so callers cannot mint a second cleanup attempt.
type ScratchCleanupBinding struct {
	Creation  Binding
	Directory DirectoryIdentity
}

func (b ScratchCleanupBinding) Valid() bool {
	return validBinding(b.Creation) && b.Creation.Identity.Scope == ScopeOwnerSettings &&
		b.Creation.Scratch.Valid() && b.Directory.Valid() && b.Creation.Scratch.ExpectedInventory == EmptyScratchInventory
}

// ScratchCleanupState is an immutable one-attempt record. The repository and
// current owner must independently check the original creation, process fence,
// native identity and current authority before admitting any deletion.
type ScratchCleanupState struct {
	binding ScratchCleanupBinding
	phase   Phase
	failure *Failure
}

func (s ScratchCleanupState) Binding() ScratchCleanupBinding { return s.binding }
func (s ScratchCleanupState) Phase() Phase                   { return s.phase }
func (s ScratchCleanupState) Failure() *Failure {
	if s.failure == nil {
		return nil
	}
	copy := *s.failure
	return &copy
}

// NewScratchCleanup requires the exact completed original. Prepared, failed
// and unknown creation records never imply a removable directory.
func NewScratchCleanup(creation *State) (*ScratchCleanupState, error) {
	if creation == nil {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	if _, err := Restore(creation.binding, creation.phase, creation.receipt, creation.failure); err != nil || creation.phase != Completed || creation.receipt == nil || creation.receipt.Operation != ScratchKind {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	return RestoreScratchCleanup(ScratchCleanupBinding{Creation: creation.binding, Directory: creation.receipt.Directory}, Prepared, nil)
}

// Restore validates stored values only; matching the persisted parent is an
// independent repository check and must happen under the original journal lock.
func RestoreScratchCleanup(binding ScratchCleanupBinding, phase Phase, failure *Failure) (*ScratchCleanupState, error) {
	valid := binding.Valid()
	switch phase {
	case Prepared, Completed:
		valid = valid && failure == nil
	case Failed:
		valid = valid && failure != nil && failure.Directory == (DirectoryIdentity{}) && validFailure(*failure, false)
	case OutcomeUnknown:
		valid = valid && failure != nil && failure.Directory == (DirectoryIdentity{}) && validFailure(*failure, true)
	default:
		valid = false
	}
	if !valid {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	s := &ScratchCleanupState{binding: binding, phase: phase}
	if failure != nil {
		copy := *failure
		s.failure = &copy
	}
	return s, nil
}

// Apply cannot rebind or reopen a terminal attempt. Prepared is observation
// only after interruption; this transition does not itself permit execution.
func (s ScratchCleanupState) Apply(next ScratchCleanupState) (*ScratchCleanupState, error) {
	if _, err := RestoreScratchCleanup(s.binding, s.phase, s.failure); err != nil {
		return nil, err
	}
	copy, err := RestoreScratchCleanup(next.binding, next.phase, next.failure)
	if err != nil {
		return nil, err
	}
	if s.binding != next.binding {
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

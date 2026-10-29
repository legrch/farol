package mutation

// ScratchFileInventory binds one observed physical file to the exact durable
// connector mutation that produced it and the original scratch creation. It
// is journal correlation, not authority to remove a file: the caller must also
// retain continuous native file custody and the whole-run process fence.
type ScratchFileInventory struct {
	Creation ScratchCleanupBinding
	Mutation Binding
	File     DirectoryIdentity
	SHA256   string
}

// NewScratchFileInventory rejects prepared, failed and unknown operations.
// Repository admission must independently re-read both durable original
// records under its writer lock. A digest or inode alone is never custody.
func NewScratchFileInventory(creation, file *State, physical DirectoryIdentity) (*ScratchFileInventory, error) {
	cleanup, err := NewScratchCleanup(creation)
	if err != nil || file == nil || !physical.Valid() {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	if _, err := Restore(file.Binding(), file.Phase(), file.Receipt(), file.Failure()); err != nil || file.Phase() != Completed || file.Receipt() == nil {
		return nil, stateError("WORKSPACE_MUTATION_STATE_INVALID")
	}
	b, c, receipt := file.Binding(), cleanup.Binding().Creation, file.Receipt()
	if b.Identity.Scope != ScopeConnector || b.Identity.OwnerID != c.Identity.OwnerID || b.Identity.ProfileID != c.Identity.ProfileID || b.Identity.ComputerID != c.Identity.ComputerID || b.Identity.OperationID == c.Identity.OperationID || b.ComputerGeneration != c.ComputerGeneration || b.WorkspaceID != c.WorkspaceID || b.RelativePath != c.RelativePath+"/check.txt" || receipt.RelativePath != b.RelativePath || (receipt.Operation != WriteKind && receipt.Operation != EditKind) || !SHA256(receipt.AfterSHA256) {
		return nil, stateError("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return &ScratchFileInventory{Creation: cleanup.Binding(), Mutation: b, File: physical, SHA256: receipt.AfterSHA256}, nil
}

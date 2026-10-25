package port

// PreservedRecoveryBinding is value metadata for the original Chat namespace.
// Its original host and child lifetimes may be unobserved.
type PreservedRecoveryBinding struct {
	Scope                JournalScope
	ParentRoot, ChatRoot JournalRoot
}

// PreservedRecoverySelection pins independently selected original metadata.
// BuildID, HostLifetimeID and ChildLaunchID identify only future initiating
// maintenance; none attests the original process or grants successor authority.
type PreservedRecoverySelection struct {
	OperationID                                   string
	Current                                       PreservedRecoveryBinding
	Next                                          JournalScope
	BuildID, HostLifetimeID, ChildLaunchID        string
	HandoffDigest, LifecycleDigest, ResultsDigest [32]byte
}

// PreservedRecoveryObservation is a content-free projection supplied by canonical
// inspectors under retained claims. Physical identities and digests are caller
// supplied comparisons, not proof of custody, closure or successful effects.
type PreservedRecoveryObservation struct {
	Scope                                                       JournalScope
	ParentRoot, ChatRoot, ResultsRoot, ResultsStorageRoot       JournalRoot
	HandoffDigest, LifecycleDigest, ResultsDigest               [32]byte
	HandoffSteps, WriteCount, TurnCount, PlanCount, ResultCount int
	Incarnations                                                []string
	RetirementPresent, ResultsUnresolved                        bool
}

// PreservedRecoveryPlan selects archive metadata for original Chat. Nonempty
// observations use archive policy; consumed empty history uses empty-recovery
// policy. Neither route changes the enclosing process/maintenance prerequisites.
// It carries no retirement, ACK, terminal, restored handle or admission authority.
// RetainsUnresolvedResults records only the observed unresolved-results status.
type PreservedRecoveryPlan struct {
	Selection                PreservedRecoverySelection
	ArchiveName              string
	RetainsUnresolvedResults bool
}

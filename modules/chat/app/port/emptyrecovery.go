package port

// EmptyRecoverySelection is an exact maintenance selection. It is neither a
// restored owner nor proof that any previous child or provider stopped.
type EmptyRecoverySelection struct {
	OperationID                            string
	Current                                HandoffBinding
	HeadDigest, LifecycleDigest            [32]byte
	Next                                   JournalScope
	BuildID, HostLifetimeID, ChildLaunchID string
}

// EmptyRecoveryObservation is supplied only by bounded canonical inspectors
// while their existing claims remain held. No prompt, result or handle crosses
// this boundary. Process closure and unrelated owner settlement belong to the
// enclosing trusted maintenance guard, not these journal projections.
type EmptyRecoveryObservation struct {
	Head                            HandoffHead
	Scope                           JournalScope
	Root                            JournalRoot
	LifecycleDigest                 [32]byte
	Incarnations                    []string
	WriteCount, TurnCount           int
	RetirementPresent               bool
	ResultsRoot, ResultsStorageRoot JournalRoot
	ResultCount                     int
}

// EmptyRecoveryPlan only selects preservation of an empty closed Chat storage
// incarnation. It deliberately implements no CleanRetirement method. The old
// root, claims and complete journal must remain preserved; a new root must have
// a different physical identity and its own actual live-owner retirement.
type EmptyRecoveryPlan struct {
	Selection   EmptyRecoverySelection
	ArchiveName string
}

// EmptyRecoveryRecordValidator is injected by trusted composition. The existing
// handoff owner retains canonical record rules; recovery defines no second codec
// and imports no other application service.
type EmptyRecoveryRecordValidator interface {
	Validate(HandoffRecord) error
}

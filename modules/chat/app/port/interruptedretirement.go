package port

// InterruptedRetirementSelection pins the original empty retirement whose host
// ACK is known but whose terminal outcome remains unknown. It grants no retry,
// terminal observation, restored owner or CleanRetirement proof.
type InterruptedRetirementSelection struct {
	EmptyRecoverySelection
	OriginalHandoffID string
	ExpectedACKDigest [32]byte
}

// InterruptedRetirementObservation comes from canonical bounded inspectors
// while their existing claims remain held. Retirement is a copied persisted
// write, never a live-owner proof. Enclosing composition owns process closure,
// Computer settlement and preservation of the complete old unknown storage.
type InterruptedRetirementObservation struct {
	EmptyRecoveryObservation
	Retirement *RetirementWrite
}

package port

// HelperCorrelation is the exact existing helper operation binding, not an
// admission or readiness witness. The application constructs it from the
// validated HelperRequest and compares every value before accepting continuation.
type HelperCorrelation struct {
	OperationID, Action string
	Source, Target      HelperBuild
	PID                 int64
	ProcessStart        string
	Predecessor         *HelperPredecessor
	LeaseIdentity       *HelperIdentity
}

type HelperHandoffFrame struct {
	Schema, Phase string
	Correlation   HelperCorrelation
	Error         *string
}

type HelperContinueFrame struct {
	Schema      string
	Correlation HelperCorrelation
}

// HelperProtocolCodec owns bounded structural JSON/encoding only. It rejects
// duplicate/unknown/missing keys, malformed Unicode, nulls and incorrect types.
// Handoff emits compact ASCII-safe JSON plus newline, preserving the existing
// producer's 4096-byte bound. Continue accepts one bounded complete JSON object.
// Inputs are not mutated during a call; outputs retain no mutable input aliases.
// Application phase, operation equality and admission remain with the consumer.
type HelperProtocolCodec interface {
	Handoff(HelperHandoffFrame) ([]byte, error)
	Continue([]byte) (HelperContinueFrame, error)
}

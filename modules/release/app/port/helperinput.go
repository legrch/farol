package port

// HelperRequest describes the existing installed-helper input. Parsing it grants
// no filesystem, process, lease, journal or installation authority.
type HelperRequest struct {
	Schema, Action, Home, OperationID string
	Source, Target                    HelperBuild
	Drain                             HelperDrain
	PID                               int64
	ProcessStart                      string
	WaitSeconds                       int
	Relaunch                          bool
	RelaunchPresentation              *string
	InstallLocation                   *string
	Predecessor                       *HelperPredecessor
	LeaseIdentity                     *HelperIdentity
}

type HelperBuild struct{ Digest, Version, BuildID string }
type HelperIdentity struct{ Device, Inode string }
type HelperDrain struct{ Status, AcceptedSource, AcceptedTarget string }
type HelperPredecessor struct {
	Kind, StartedAt, LastQuitSHA256 string
	StateIdentity                   HelperIdentity
}

// HelperInputDecoder is a trusted, bounded structural decoder. Implementations
// reject ambiguous JSON, unknown/missing keys, nulls and incorrect field types.
// The composition root supplies a nonnil implementation that does not panic.
type HelperInputDecoder interface {
	Decode([]byte) (HelperRequest, error)
}

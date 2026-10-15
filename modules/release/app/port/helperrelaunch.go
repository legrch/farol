package port

// HelperSelfIdentity is the original helper's own measured identity, supplied
// by trusted native composition. It is never the parent identity from input.
type HelperSelfIdentity struct {
	PID          int64
	ProcessStart string
}

// HelperRelaunchHint is correlation data, not authority to launch or acquire a
// busy owner lease. The native codec fixes the existing JSON representation.
type HelperRelaunchHint struct {
	OperationID, Action, Phase, BuildID string
	Helper                              HelperSelfIdentity
}

// HelperRelaunchCodec returns captured compact ASCII-safe JSON without a line
// terminator, bounded to 2048 encoded bytes. It retains no mutable input/output
// aliases and returns closed helper_protocol_size/encoding failures. Trusted
// composition supplies a non-panicking implementation without a typed nil.
type HelperRelaunchCodec interface {
	Relaunch(HelperRelaunchHint) ([]byte, error)
}

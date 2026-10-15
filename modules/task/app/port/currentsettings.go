package port

// TaskSettingsNumber preserves an exact JSON number, without a floating point
// conversion. Decoders normalize equivalent decimal spellings deterministically.
type TaskSettingsNumber string

// MarshalJSON keeps a number distinct from a string in canonical comparison
// bytes. encoding/json validates the returned numeric token before using it.
func (n TaskSettingsNumber) MarshalJSON() ([]byte, error) { return []byte(n), nil }

// TaskSettingsValue is recursively nil, bool, string, TaskSettingsNumber,
// []any or map[string]any. These are saved values, never source authority.
type TaskSettingsValue = any

type TaskSettingsPolicyKind uint8

const (
	TaskSettingsPolicyValid TaskSettingsPolicyKind = iota
	TaskSettingsPolicyMissing
	TaskSettingsPolicyInvalid
)

type TaskSettingsPolicyIdentity struct {
	Kind   TaskSettingsPolicyKind
	SHA256 string
}

// TaskSettingsPolicyIdentityResolver identifies the complete semantic policy,
// including unsupported harnesses, without selecting or executing one. Errors
// mean unavailable, never missing/invalid. Implementations are deterministic,
// concurrency safe, perform no IO and retain no input. Trusted composition
// supplies non-panicking adapters, never typed nils.
type TaskSettingsPolicyIdentityResolver interface {
	IdentifyTaskPolicy([]byte) (TaskSettingsPolicyIdentity, error)
}

type TaskCurrentSettingsFacts struct {
	Status      string
	Tasks       []byte
	NativeHosts TaskCurrentNativeHosts
	Computer    TaskCurrentComputer
	Setup       TaskCurrentSetup
}

type TaskCurrentNativeHosts struct {
	Generation  string
	Route, Host map[string]any
}

type TaskCurrentComputer struct {
	ComputerID, Generation string
	Workspaces             []TaskCurrentWorkspace
}

type TaskCurrentWorkspace struct {
	WorkspaceID, Root, Access string
	RootIdentity, GitMetadata TaskSettingsValue
	ExcludedPaths             []string
	GitHistoryApproved        *bool
}

type TaskCurrentSetup struct {
	Verified       TaskSettingsValue
	Reachable      string
	OutcomeUnknown bool
}

// TaskCurrentSettingsDecoder strictly validates the closed snapshot envelope
// and relevant typed facts. It rejects duplicate keys, malformed Unicode,
// trailing values, depth >128, >65536 decoded values and inputs >1MiB. It
// performs no IO, is concurrency safe, retains no input and returns caller-owned
// values. Trusted composition supplies a non-panicking adapter, never typed nil.
type TaskCurrentSettingsDecoder interface {
	Decode([]byte) (TaskCurrentSettingsFacts, error)
}

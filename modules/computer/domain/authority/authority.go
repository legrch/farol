// Package authority owns pure execution authority. Callers supply time and
// current approval snapshots; this package performs no IO or ambient lookup.
package authority

import "time"

type Capability string

const (
	List       Capability = "workspace.list"
	Read       Capability = "workspace.read"
	Search     Capability = "workspace.search"
	Verify     Capability = "verification.run"
	Write      Capability = "workspace.write"
	Shell      Capability = "workspace.shell"
	NetworkUse Capability = "network.use"
)

type Access string

const (
	ReadAccess  Access = "read"
	WriteAccess Access = "write"
)

type Network string

const (
	NoNetwork       Network = "none"
	ApprovedNetwork Network = "approved"
)

type Commands string

const (
	NoCommands           Commands = "none"
	VerificationCommands Commands = "verification"
	WorkspaceCommands    Commands = "workspace"
)

type Role string

const (
	Main   Role = "main"
	Agent  Role = "agent"
	Critic Role = "critic"
)

type Ownership string

const (
	NoOwnership   Ownership = "none"
	TaskOwnership Ownership = "task"
)

type Mode string

const (
	Subtree Mode = "subtree"
	Exact   Mode = "exact"
)

type Source string

const (
	ComputerApprovalSource Source = "computer-approval"
	TaskAdmissionSource    Source = "task-admission"
	TaskGrantSource        Source = "task-grant"
	OwnerRestrictionSource Source = "owner-restriction"
	UnknownSource          Source = "unknown"
)

type Identity struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
}
type RootIdentity struct{ Device, Inode string }
type GitMetadata struct{ GitDirectory, CommonDirectory string }
type ApprovedWorkspace struct {
	WorkspaceID, Root                 string
	Access                            Access
	RootIdentity                      RootIdentity
	GitMetadata                       *GitMetadata
	GitHistoryApproved, ShellVerified bool
}
type Scope struct {
	WorkspaceID, Root string
	Mode              Mode
	Paths             []string
	Access            Access
	RestrictionSource Source
}
type Exclusion struct {
	WorkspaceID, Path string
	RestrictionSource Source
}
type Policy struct {
	FilePolicy    FilePolicy
	Workspaces    []Scope
	ExcludedPaths []Exclusion
	Capabilities  []Capability
	Network       Network
	Commands      Commands
	ExpiresAt     time.Time
}
type Approval struct {
	OwnerID, ComputerID string
	Generation          uint64
	FilePolicy          FilePolicy
	Workspaces          []ApprovedWorkspace
	ExcludedPaths       []Exclusion
	Capabilities        []Capability
	Network             Network
	Commands            Commands
	ExpiresAt           time.Time
}
type Admission struct {
	Identity
	AuthorityID, ComputerID string
	ComputerGeneration      uint64
	Policy
}
type Grant struct {
	Identity
	AuthorityID, ComputerID string
	ComputerGeneration      uint64
	Policy
}
type Participant struct {
	ParticipantID, ParentParticipantID string
	Role                               Role
	MutationOwnership                  Ownership
	Grant                              Grant
}
type ParticipantAdmission struct {
	ParticipantID     string
	Role              Role
	MutationOwnership Ownership
}
type Narrowing struct {
	Workspaces    []Scope
	ExcludedPaths []Exclusion
	Capabilities  []Capability
	Network       Network
	Commands      Commands
}
type Delegation struct {
	ParticipantAdmission
	Narrowing *Narrowing
}
type Operation struct {
	Kind              Capability
	WorkspaceID, Path string
	Write             bool
}
type Action struct {
	Identity
	Operation Operation
}
type NativeHost struct {
	HostTaskID, OwnerID, TaskID string
	TaskEpoch                   uint64
	Policy
}

// Failure is classified and never authorizes automatic retry. Adapters preserve
// only allowlisted error codes, never raw native diagnostics or private paths.
type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string               { return f.Code + " (" + f.Source + ")" }
func Fail(code, source string) *Failure        { return &Failure{Code: code, Source: source, Retry: "never"} }
func fail(code string, source Source) *Failure { return Fail(code, string(source)) }

// Clone returns an independent snapshot suitable for retaining across a yield.
func (g Grant) Clone() Grant { g.Policy = clonePolicy(g.Policy); return g }
func cloneScopes(scopes []Scope) []Scope {
	out := append([]Scope(nil), scopes...)
	for i := range out {
		out[i].Paths = append([]string(nil), out[i].Paths...)
	}
	return out
}
func clonePolicy(p Policy) Policy {
	p.Workspaces = cloneScopes(p.Workspaces)
	p.ExcludedPaths = append([]Exclusion(nil), p.ExcludedPaths...)
	p.Capabilities = append([]Capability(nil), p.Capabilities...)
	return p
}
func FindScope(g Grant, workspaceID string) (Scope, bool) {
	for _, scope := range g.Workspaces {
		if scope.WorkspaceID == workspaceID {
			scope.Paths = append([]string(nil), scope.Paths...)
			return scope, true
		}
	}
	return Scope{}, false
}
func FindApproved(a Approval, workspaceID string) (ApprovedWorkspace, bool) {
	for _, workspace := range a.Workspaces {
		if workspace.WorkspaceID == workspaceID {
			return workspace, true
		}
	}
	return ApprovedWorkspace{}, false
}

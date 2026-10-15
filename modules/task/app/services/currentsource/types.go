// Package currentsource derives saved Task source metadata without authority,
// IO, ambient clocks, catalogue selection or execution. Full ProductSettings
// parsing remains at the transport boundary; reduced facts cannot certify
// omitted Settings fields.
package currentsource

const (
	MaxSnapshotBytes = 1 << 20
	Invalid          = "TASK_CURRENT_SOURCE_INVALID"
	Unavailable      = "TASK_CURRENT_SOURCE_UNAVAILABLE"
	Available        = "available"
	Absent           = "absent"
)

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Root struct {
	Path               string `json:"path"`
	Device             string `json:"device"`
	Inode              string `json:"inode"`
	GitCommonDirectory string `json:"gitCommonDirectory"`
}
type Followup struct {
	Kind             string `json:"kind"`
	Protocol         string `json:"protocol"`
	BaseSchemaSHA256 string `json:"baseSchemaSha256"`
	SchemaSHA256     string `json:"schemaSha256"`
}
type CodexSource struct {
	ProjectID                  string    `json:"projectId"`
	WorkspaceID                string    `json:"workspaceId"`
	Project                    Root      `json:"project"`
	Writer                     Root      `json:"writer"`
	ModelAlias                 string    `json:"modelAlias"`
	Model                      string    `json:"model"`
	Effort                     *string   `json:"effort,omitempty"`
	ConfigDigest               string    `json:"configDigest"`
	ExecutablePath             string    `json:"executablePath"`
	ExecutableSHA256           string    `json:"executableSha256"`
	Protocol                   string    `json:"protocol"`
	BaseSchemaSHA256           string    `json:"baseSchemaSha256"`
	HandoffSchemaSHA256        string    `json:"handoffSchemaSha256"`
	Followup                   *Followup `json:"followup,omitempty"`
	SocketPath                 string    `json:"socketPath"`
	ExpectedCodexHome          string    `json:"expectedCodexHome"`
	Sandbox                    string    `json:"sandbox"`
	ApprovalPolicy             string    `json:"approvalPolicy"`
	GrantedAt                  string    `json:"grantedAt"`
	ExpiresAt                  string    `json:"expiresAt"`
	HostGeneration             string    `json:"hostGeneration"`
	ComputerGeneration         string    `json:"computerGeneration"`
	GrantHostGeneration        string    `json:"grantHostGeneration"`
	GrantComputerGeneration    string    `json:"grantComputerGeneration"`
	VerifiedWorkspaceID        string    `json:"verifiedWorkspaceId"`
	VerifiedComputerGeneration string    `json:"verifiedComputerGeneration"`
	Access                     string    `json:"access"`
	ProjectBoundCreateStatus   bool      `json:"projectBoundCreateStatus"`
}
type ReadReference struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
}
type Result struct {
	Status string         `json:"status"`
	Source *CodexSource   `json:"source,omitempty"`
	Read   *ReadReference `json:"read,omitempty"`
}

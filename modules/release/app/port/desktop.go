package port

// Desktop lifetime metadata grants observation custody, never update authority.
type DesktopLifetimeBuild struct {
	BuildID string `json:"buildId"`
	Digest  string `json:"digest"`
	Version string `json:"version"`
}
type DesktopLifetimeProcess struct {
	PID   int    `json:"pid"`
	Start string `json:"processStart"`
}
type DesktopLifetimeBinding struct {
	Schema      string                 `json:"schema"`
	OperationID string                 `json:"operationId"`
	Action      string                 `json:"action"`
	Location    string                 `json:"installLocation"`
	Source      DesktopLifetimeBuild   `json:"source"`
	Target      DesktopLifetimeBuild   `json:"target"`
	Predecessor DesktopLifetimeProcess `json:"predecessor"`
	Helper      DesktopLifetimeProcess `json:"helper"`
	Deadline    int64                  `json:"deadlineAt"`
}

// Package process publishes independent selected-operation DTOs. It is not an
// exec-anything wire protocol, process lookup, task owner or admission authority.
package process

import (
	"errors"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Contract struct{ service *processsvc.Service }

func New(service *processsvc.Service) (*Contract, error) {
	if service == nil {
		return nil, &Failure{Code: "PROCESS_UNAVAILABLE", Outcome: "refused", Retry: "never"}
	}
	return &Contract{service: service}, nil
}

type Failure struct {
	Code, Outcome, Retry string
	NativeRefusalReason  string
}

func (e *Failure) Error() string { return e.Code }
func failure(err error) error {
	var local *processsvc.Failure
	var native *authority.Failure
	if errors.As(err, &local) {
		outcome := "refused"
		if local.Unknown {
			outcome = "outcome_unknown"
		}
		return &Failure{Code: local.Code, Outcome: outcome, Retry: "never", NativeRefusalReason: NativeRefusalReason(local.Code, string(local.NativeRefusalReason))}
	}
	if errors.As(err, &native) && validCode(native.Code) {
		return &Failure{Code: native.Code, Outcome: "refused", Retry: "never"}
	}
	return &Failure{Code: "PROCESS_UNAVAILABLE", Outcome: "outcome_unknown", Retry: "never"}
}

// Independent closed values; generated transport DTOs remain Core-owned.
type State string

const (
	Running  State = "running"
	Terminal State = "terminal"
	Exited   State = "exited"
	Unknown  State = "unknown"
)

type SupervisorState string

const (
	SupervisorRunning SupervisorState = "running"
	SupervisorExited  SupervisorState = "exited"
	SupervisorUnknown SupervisorState = "unknown"
)

type RootState string

const (
	RootRunning RootState = "running"
	RootExited  RootState = "exited"
)

type Cleanup string

const (
	CleanupPending    Cleanup = "pending"
	CleanupConfirmed  Cleanup = "confirmed"
	CleanupUnverified Cleanup = "unverified"
)

type CancelStatus string

const (
	CancelRequested CancelStatus = "requested"
	AlreadyTerminal CancelStatus = "already_terminal"
	CancelUnknown   CancelStatus = "unknown"
)

func validCode(value string) bool {
	if len(value) < 1 || len(value) > 120 {
		return false
	}
	for i, ch := range value {
		if !(ch >= 'A' && ch <= 'Z' || i > 0 && (ch >= '0' && ch <= '9' || ch == '_')) {
			return false
		}
	}
	return true
}

// NativeRefusalReason maps only the native-refused public code. Unknown input
// is diagnostic unclassified, never a retry or outcome assertion.
func NativeRefusalReason(code, reason string) string {
	if code != "PROCESS_NATIVE_REFUSED" {
		return ""
	}
	switch reason {
	case "admission_policy", "confinement_policy", "executable_integrity", "workspace_root_identity", "cwd_fence", "directory_policy", "filesystem_policy", "runtime_integrity", "helper_preflight", "unclassified":
		return reason
	default:
		return "unclassified"
	}
}

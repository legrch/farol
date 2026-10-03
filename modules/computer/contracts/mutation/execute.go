package mutation

import (
	"context"
	"errors"

	app "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// These DTOs are independent from domain/app state. No client ACK, renewal,
// owner lookup or concrete native/journal infrastructure crosses this contract.
type ExecuteRequest = CheckRequest
type Receipt struct {
	Operation, RelativePath string
	Bytes                   uint64
	Replacements            uint32
	BeforeSHA256            *string
	AfterSHA256             string
}
type OutcomeFailure struct{ Code, Source, Retry string }
type ExecuteResponse struct {
	OperationID, WorkspaceID, CallID, TurnID string
	Generation                               uint64
	Phase, Publication                       string
	Receipt                                  *Receipt
	Failure                                  *OutcomeFailure
}

func (c *Contract) Execute(ctx context.Context, r ExecuteRequest) (*ExecuteResponse, error) {
	if c == nil || c.service == nil {
		return nil, boundary(nil)
	}
	out, err := c.service.Execute(ctx, toApp(r))
	if err != nil || out == nil {
		return nil, boundary(err)
	}
	return response(out), nil
}
func response(r *app.ExecuteResponse) *ExecuteResponse {
	out := &ExecuteResponse{OperationID: r.OperationID, WorkspaceID: r.WorkspaceID, CallID: r.CallID, TurnID: r.TurnID, Generation: r.Generation, Phase: r.Phase, Publication: r.Publication}
	if r.Receipt != nil {
		v := r.Receipt
		out.Receipt = &Receipt{Operation: v.Operation, RelativePath: v.RelativePath, Bytes: v.Bytes, Replacements: v.Replacements, BeforeSHA256: cloneHash(v.BeforeSHA256), AfterSHA256: v.AfterSHA256}
	}
	if r.Failure != nil {
		out.Failure = &OutcomeFailure{Code: r.Failure.Code, Source: r.Failure.Source, Retry: "never"}
	}
	return out
}
func boundary(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) && allowedCode(f.Code) && allowedSource(f.Source) {
		return &Failure{Code: f.Code, Source: f.Source, Retry: "never"}
	}
	return &Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
}
func allowedCode(code string) bool {
	if domain.NativeCode(code) {
		return true
	}
	switch code {
	case "COMPUTER_INVALID_REQUEST", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "COMPUTER_PARTICIPANT_NOT_FOUND", "COMPUTER_APPROVAL_NOT_FOUND", "COMPUTER_MUTATION_STORE_UNAVAILABLE", "COMPUTER_MUTATION_FINGERPRINT_FAILED", "COMPUTER_MUTATION_OPERATION_CONFLICT", "COMPUTER_MUTATION_OPERATION_NOT_FOUND", "COMPUTER_MUTATION_IN_PROGRESS",
		"AUTHORITY_OWNER_MISMATCH", "AUTHORITY_TASK_MISMATCH", "AUTHORITY_COMPUTER_MISMATCH", "AUTHORITY_EXPIRED", "AUTHORITY_INFLATION_DENIED", "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED", "AUTHORITY_NETWORK_DENIED", "AUTHORITY_COMMAND_DENIED", "AUTHORITY_MUTATION_OWNERSHIP_DENIED":
		return true
	}
	return false
}
func allowedSource(source string) bool {
	switch source {
	case "contract", "authority-store", "operation-store", "native-workspace", "computer-approval", "task-admission", "task-grant", "owner-restriction", "role", "computer-policy", "native-host":
		return true
	}
	return false
}

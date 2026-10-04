package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func settingsMutationResult(operation, workspace, path string, generation uint64, out *mutationct.OwnerResponse) (*wire.ComputerSettingsMutationResponse, error) {
	invalid := func() (*wire.ComputerSettingsMutationResponse, error) {
		return nil, errors.New("settings_mutation_result_crossed")
	}
	if out == nil || out.OperationID != operation || out.WorkspaceID != workspace || out.ComputerGeneration != generation {
		return invalid()
	}
	result := &wire.ComputerSettingsMutationResponse{OperationId: operation, WorkspaceId: workspace, ComputerGeneration: decimal(generation), Phase: out.Phase, Publication: out.Publication}
	switch out.Phase {
	case "completed":
		v := out.Receipt
		if v == nil || out.Failure != nil || v.Operation != "edit" || v.RelativePath != path || v.Bytes > 8*1024*1024 || v.Replacements < 1 || v.Replacements > 256 || v.BeforeSHA256 == nil {
			return invalid()
		}
		hash := *v.BeforeSHA256
		result.Receipt = &wire.ComputerMutationReceipt{Operation: v.Operation, RelativePath: v.RelativePath, Bytes: decimal(v.Bytes), Replacements: v.Replacements, BeforeSHA256: &hash, AfterSHA256: v.AfterSHA256}
	case "failed", "outcome_unknown":
		v := out.Failure
		if v == nil || out.Receipt != nil || v.Retry != "never" || (out.Phase == "outcome_unknown") != (v.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN") {
			return invalid()
		}
		result.Failure = &wire.ComputerMutationFailure{Code: v.Code, Source: v.Source, Retry: v.Retry}
	default:
		return invalid()
	}
	if validateIngress("ComputerSettingsMutationResponse", result) != nil {
		return invalid()
	}
	return result, nil
}
func settingsMutationOutcome(value *wire.ComputerSettingsMutationResponse, err error) (*desktop.Outcome, error) {
	if err == nil {
		return ingressOutcome(value, nil)
	}
	var mutation *mutationct.Failure
	var workspace *workspacect.Failure
	var policy *authority.Failure
	code := ""
	switch {
	case errors.As(err, &mutation):
		code = mutation.Code
	case errors.As(err, &workspace):
		code = workspace.Code
	case errors.As(err, &policy):
		code = policy.Code
	default:
		return nil, err
	}
	status := "refused"
	if code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		status = "unknown"
	}
	return &desktop.Outcome{Status: status, Code: code}, nil
}
func (s *SettingsMutationIngress) Methods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.settings.edit": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || len(r.Body) > 512*1024 || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSettingsEditRequest", r.Body) != nil {
				return invalidIngress()
			}
			var in wire.ComputerSettingsEditRequest
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			out, err := s.edit(ctx, r.OperationID, in)
			return settingsMutationOutcome(out, err)
		}},
		"computer.settings.mutation.read": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSettingsMutationRead", r.Body) != nil {
				return invalidIngress()
			}
			var in wire.ComputerSettingsMutationRead
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			out, err := s.observe(ctx, in)
			return settingsMutationOutcome(out, err)
		}},
	}
}

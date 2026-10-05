package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// A current request selects neither an owner nor a write lease. The socket's
// previously selected slot must still be the exact live connector incarnation.
// Release this short admission gate before repository or native IO; the original
// execution/read lease rechecks authority at the existing effect/disclosure gates.
func (s *computerConnector) checkMutationSlot(ctx context.Context, slot *connectorSlot, current wire.ComputerConnectorExecution) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.effects }()
	if slot == nil || s.current != slot || slot.closing || slot.startupUncertain || slot.opened.Execution != current || s.mutations == nil || s.mutations.computer != s.root {
		return computerUnavailable()
	}
	return nil
}

// Original correlation remains separate from the current request. In particular,
// reconnect may read an older result but cannot rewrite its host/call provenance.
func connectorMutationWireResult(slot *connectorSlot, call, operation, workspace, path string, input mutationct.Operation, out *mutationct.ConnectorResponse) (*wire.ComputerConnectorMutationResponse, error) {
	invalid := func() (*wire.ComputerConnectorMutationResponse, error) {
		return nil, errors.New("connector_mutation_result_crossed")
	}
	if slot == nil || out == nil || out.OperationID != operation || out.WorkspaceID != workspace || out.RelativePath != path || out.ComputerGeneration > state.MaxSafeInteger {
		return invalid()
	}
	o := out.Origin
	if o.ConnectorGeneration == 0 || o.TaskEpoch == 0 || o.TaskEpoch > state.MaxSafeInteger || o.Generation == 0 || o.Generation > state.MaxSafeInteger {
		return invalid()
	}
	current := slot.opened.Execution
	origin := wire.ComputerConnectorMutationOrigin{
		Binding:   wire.ComputerConnectorBinding{BuildId: o.BuildID, ProfileId: slot.opened.Endpoint.Binding.ProfileId, BackendGeneration: o.BackendGeneration, RuntimeId: o.RuntimeID, ConnectorGeneration: decimal(o.ConnectorGeneration)},
		Execution: wire.ComputerConnectorExecution{OwnerId: current.OwnerId, SessionId: o.SessionID, TaskId: o.TaskID, TaskEpoch: decimal(o.TaskEpoch), ParticipantId: o.ParticipantID, TurnId: o.TurnID, Generation: decimal(o.Generation)},
		CallId:    o.CallID, Operation: o.Operation,
	}
	var before *string
	if input != nil {
		_, kind := connectorMutationTarget(input)
		if origin.Binding != slot.opened.Endpoint.Binding || origin.Execution != current || origin.CallId != call || origin.Operation != string(kind) || decimal(out.ComputerGeneration) != slot.guard.publication.Generation {
			return invalid()
		}
		switch v := input.(type) {
		case mutationct.Write:
			before = v.ExpectedSHA256
		case mutationct.Edit:
			before = &v.ExpectedSHA256
		default:
			return invalid()
		}
	}
	result := &wire.ComputerConnectorMutationResponse{Execution: current, CallId: call, OperationId: operation, WorkspaceId: workspace, RelativePath: path, ComputerGeneration: decimal(out.ComputerGeneration), Origin: origin, Phase: out.Phase, Publication: out.Publication}
	switch out.Phase {
	case "completed":
		v := out.Receipt
		if v == nil || out.Failure != nil || v.Operation != origin.Operation || v.RelativePath != path || v.Bytes > 8*1024*1024 || v.Replacements > 256 ||
			(v.Operation == "write" && v.Replacements != 0) || (v.Operation == "edit" && (v.Replacements == 0 || v.BeforeSHA256 == nil)) {
			return invalid()
		}
		if input != nil && ((before == nil) != (v.BeforeSHA256 == nil) || before != nil && *before != *v.BeforeSHA256) {
			return invalid()
		}
		result.Receipt = &wire.ComputerMutationReceipt{Operation: v.Operation, RelativePath: v.RelativePath, Bytes: decimal(v.Bytes), Replacements: v.Replacements, AfterSHA256: v.AfterSHA256}
		if v.BeforeSHA256 != nil {
			hash := *v.BeforeSHA256
			result.Receipt.BeforeSHA256 = &hash
		}
	case "failed", "outcome_unknown":
		v := out.Failure
		if v == nil || out.Receipt != nil || v.Retry != "never" || (out.Phase == "outcome_unknown") != (v.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN") {
			return invalid()
		}
		result.Failure = &wire.ComputerMutationFailure{Code: v.Code, Source: v.Source, Retry: "never"}
	default:
		return invalid()
	}
	data, err := json.Marshal(result)
	if err != nil || len(data) > 64*1024 || wire.Validate("ComputerConnectorMutationResponse", data) != nil {
		return invalid()
	}
	return result, nil
}

func connectorMutationOutcome(value *wire.ComputerConnectorMutationResponse, err error) (*desktop.Outcome, error) {
	if err != nil {
		var unsettled *connectorMutationUnsettled
		if errors.As(err, &unsettled) {
			return &desktop.Outcome{Status: "unknown", Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"}, nil
		}
		return settingsMutationOutcome(nil, err)
	}
	return ingressOutcome(value, nil)
}

func (s *computerConnector) mutationMethods(slot *connectorSlot) map[string]desktop.Method {
	execute := func(ctx context.Context, r desktop.Request, current wire.ComputerConnectorExecution, call, workspace string, op mutationct.Operation) (*desktop.Outcome, error) {
		if err := s.checkMutationSlot(ctx, slot, current); err != nil {
			return connectorMutationOutcome(nil, err)
		}
		out, err := s.mutate(ctx, slot, r.OperationID, call, mutationct.ConnectorRequest{WorkspaceID: workspace, Operation: op})
		if err != nil {
			return connectorMutationOutcome(nil, err)
		}
		path, _ := connectorMutationTarget(op)
		result, err := connectorMutationWireResult(slot, call, r.OperationID, workspace, path, op, out)
		return connectorMutationOutcome(result, err)
	}
	valid := func(r desktop.Request, name string, effect bool) bool {
		return (r.OperationID != "") == effect && len(r.Body) <= 512*1024 && ipc.ValidateJSON(r.Body) == nil && wire.Validate(name, r.Body) == nil
	}
	return map[string]desktop.Method{
		"computer.workspace.write": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if !valid(r, "ComputerConnectorWrite", true) {
				return invalidIngress()
			}
			var in wire.ComputerConnectorWrite
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			return execute(ctx, r, in.Execution, in.CallId, in.WorkspaceId, mutationct.Write{RelativePath: in.RelativePath, Content: in.Content, ExpectedSHA256: in.ExpectedSHA256})
		}},
		"computer.workspace.edit": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if !valid(r, "ComputerConnectorEdit", true) {
				return invalidIngress()
			}
			var in wire.ComputerConnectorEdit
			if json.Unmarshal(r.Body, &in) != nil || len(in.Edits) == 0 || len(in.Edits) > 256 {
				return invalidIngress()
			}
			edits := make([]mutationct.TextEdit, len(in.Edits))
			for i, v := range in.Edits {
				edits[i] = mutationct.TextEdit{OldText: v.OldText, NewText: v.NewText}
			}
			return execute(ctx, r, in.Execution, in.CallId, in.WorkspaceId, mutationct.Edit{RelativePath: in.RelativePath, ExpectedSHA256: in.ExpectedSHA256, Edits: edits})
		}},
		"computer.workspace.mutation.read": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if !valid(r, "ComputerConnectorMutationRead", false) {
				return invalidIngress()
			}
			var in wire.ComputerConnectorMutationRead
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			if err := s.checkMutationSlot(ctx, slot, in.Execution); err != nil {
				return connectorMutationOutcome(nil, err)
			}
			out, err := s.observeMutation(ctx, slot, in.OperationId, mutationct.ConnectorObservation{WorkspaceID: in.WorkspaceId, RelativePath: in.RelativePath})
			if err != nil {
				return connectorMutationOutcome(nil, err)
			}
			result, err := connectorMutationWireResult(slot, in.CallId, in.OperationId, in.WorkspaceId, in.RelativePath, nil, out)
			return connectorMutationOutcome(result, err)
		}},
	}
}

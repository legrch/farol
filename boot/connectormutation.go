package boot

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"

	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// The engine may have admitted or completed an effect before an error reaches
// composition (for example, final disclosure after authority expires). Only its
// retained result can settle that attempt; a typed policy error alone cannot.
type connectorMutationUnsettled struct{ cause error }

func (e *connectorMutationUnsettled) Error() string { return "connector_mutation_unsettled" }
func (e *connectorMutationUnsettled) Unwrap() error { return e.cause }

func connectorMutationTarget(op mutationct.Operation) (string, state.Kind) {
	switch v := op.(type) {
	case mutationct.Write:
		return v.RelativePath, state.WriteKind
	case mutationct.Edit:
		return v.RelativePath, state.EditKind
	default:
		return "", ""
	}
}

// Trusted composition selects slot and the existing shared mutation owner.
// External routing is a separate gate; this join opens no storage or endpoint.
func (s *computerConnector) mutate(ctx context.Context, slot *connectorSlot, operation, call string, request mutationct.ConnectorRequest) (*mutationct.ConnectorResponse, error) {
	if s == nil || s.mutations == nil || s.mutations.computer != s.root || slot == nil || slot.route == nil || slot.route.issuer == nil || slot.guard == nil || slot.guard.root != s.root ||
		ctx == nil || ctx.Err() != nil || !validIngressID(operation) || !validIngressID(call) {
		return nil, mutationInvalid()
	}
	request.Operation = mutationInputCopy(request.Operation)
	if err := mutationct.ValidateConnectorRequest(request); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(request)
	if err != nil || len(raw) > 512*1024 {
		return nil, mutationInvalid()
	}
	path, kind := connectorMutationTarget(request.Operation)
	generation, err := strconv.ParseUint(slot.guard.publication.Generation, 10, 64)
	if err != nil || generation > state.MaxSafeInteger {
		return nil, mutationInvalid()
	}
	callGeneration, err := strconv.ParseUint(slot.opened.Execution.Generation, 10, 64)
	if err != nil || callGeneration > state.MaxSafeInteger {
		return nil, mutationInvalid()
	}
	ledger := s.mutations
	ledger.mu.Lock()
	if ledger.frozen || ledger.operations[operation] != nil || len(ledger.operations) >= 4096 {
		ledger.mu.Unlock()
		return nil, &mutationct.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
	}
	record := &settingsMutationOperation{workspace: request.WorkspaceID, path: path, generation: generation, pending: true, connectorScope: true}
	ledger.operations[operation] = record
	ledger.mu.Unlock()
	finish := func(service *mutationsvc.ConnectorService, err error, settled bool) {
		ledger.mu.Lock()
		record.connector, record.failure, record.settled, record.pending = service, err, settled, false
		ledger.mu.Unlock()
	}
	if err := s.root.claim(operation); err != nil {
		finish(nil, err, true)
		return nil, err
	}
	lease, err := slot.route.issuer.Admit(ctx, authority.Write)
	if err != nil {
		finish(nil, err, true)
		return nil, err
	}
	b, h := lease.Binding(), slot.guard.host
	selected := mutationsvc.ConnectorSelection{ConnectorOwner: mutationsvc.ConnectorOwner{OperationID: operation, OwnerID: s.root.ownerID, ProfileID: s.root.peer.ProfileId, ComputerID: s.root.computerID},
		ComputerGeneration: generation, Origin: state.ConnectorOrigin{BuildID: h.BuildID, BackendGeneration: h.BackendGeneration, RuntimeID: h.RuntimeID, ConnectorGeneration: h.ConnectorGeneration,
			SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, CallID: call, Generation: callGeneration, Operation: kind}}
	service, err := mutationsvc.NewForConnectorExecution(selected, lease, ledger.dependencies.repository, ledger.dependencies.native, ledger.dependencies.digester, &sync.Mutex{}, s.clock)
	if err != nil {
		finish(nil, err, true)
		return nil, err
	}
	result, err := mutationct.NewConnectorExecution(service).Execute(ctx, request)
	finish(service, err, settledConnectorMutation(result, err))
	if err != nil {
		return nil, &connectorMutationUnsettled{cause: err}
	}
	return result, err
}

func settledConnectorMutation(result *mutationct.ConnectorResponse, err error) bool {
	return err == nil && result != nil && result.Publication == "durable" && (result.Phase == "completed" || result.Phase == "failed")
}

func (s *computerConnector) observeMutation(ctx context.Context, slot *connectorSlot, operation string, request mutationct.ConnectorObservation) (*mutationct.ConnectorResponse, error) {
	if s == nil || s.mutations == nil || s.mutations.computer != s.root || ctx == nil || ctx.Err() != nil || !validIngressID(operation) || !validIngressID(request.WorkspaceID) || !state.RelativePath(request.RelativePath) {
		return nil, mutationInvalid()
	}
	guard, err := s.mutationObservation(ctx, slot)
	if err != nil {
		return nil, err
	}
	owner := mutationsvc.ConnectorOwner{OperationID: operation, OwnerID: s.root.ownerID, ProfileID: s.root.peer.ProfileId, ComputerID: s.root.computerID}
	identity := state.Identity{Scope: state.ScopeConnector, OperationID: operation, OwnerID: owner.OwnerID, ProfileID: owner.ProfileID, ComputerID: owner.ComputerID}
	// Even an in-memory refusal is observed only under current read authority.
	if err := guard.WithMutationObservation(ctx, identity, request.WorkspaceID, request.RelativePath, func() error { return nil }); err != nil {
		return nil, err
	}
	ledger := s.mutations
	// The append-only ledger can gain an attempt while a cold Load is outside
	// all gates. Reconcile under current read authority before disclosure. At
	// most one cold read and one retained observation occur; no lease is renewed.
	for observation := 0; observation < 2; observation++ {
		ledger.mu.Lock()
		record := ledger.operations[operation]
		var service *mutationsvc.ConnectorService
		if record != nil {
			if !record.connectorScope || record.workspace != request.WorkspaceID || record.path != request.RelativePath {
				ledger.mu.Unlock()
				return nil, &mutationct.Failure{Code: "COMPUTER_MUTATION_OPERATION_CONFLICT", Source: "operation-store", Retry: "never"}
			}
			if record.pending {
				ledger.mu.Unlock()
				return nil, &mutationct.Failure{Code: "COMPUTER_MUTATION_IN_PROGRESS", Source: "operation-store", Retry: "never"}
			}
			service, err = record.connector, record.failure
		}
		ledger.mu.Unlock()
		var observer *mutationsvc.ConnectorObserver
		if record != nil {
			if service == nil {
				if err == nil {
					return nil, mutationInvalid()
				}
				return nil, err
			}
			observer, err = service.Observer(guard)
		} else {
			observer, err = mutationsvc.NewConnectorObserver(owner, ledger.dependencies.repository, guard)
		}
		if err != nil {
			return nil, err
		}
		result, err := mutationct.NewConnectorObservation(observer).Observe(ctx, request)
		if record == nil {
			appeared := false
			checkErr := guard.WithMutationObservation(ctx, identity, request.WorkspaceID, request.RelativePath, func() error {
				ledger.mu.Lock()
				appeared = ledger.operations[operation] != nil
				ledger.mu.Unlock()
				return nil
			})
			if checkErr != nil {
				return nil, checkErr
			}
			if appeared {
				continue // Inspect the original retained owner outside both gates.
			}
		} else if settledConnectorMutation(result, err) {
			ledger.mu.Lock()
			record.settled = true
			ledger.mu.Unlock()
		}
		return result, err
	}
	return nil, &mutationct.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
}

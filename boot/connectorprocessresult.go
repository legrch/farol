package boot

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	processinfra "github.com/legrch/farol/modules/computer/infra/process"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

type connectorProcessResults interface {
	LoadProcessTerminal(context.Context, domain.Identity) (*processsvc.TerminalResult, error)
}

var _ connectorProcessResults = (*mutationrepo.Repository)(nil)

func nativeProcessObservation(seal processsvc.Seal) (processsvc.ObservationWorkspace, error) {
	return processinfra.NewObservationWorkspace(processsvc.ObservedWorkspace{
		WorkspaceID: seal.WorkspaceID, Root: seal.Root, RootIdentity: seal.RootIdentity})
}

// The existing admitted READ lease already owns the current connector/Computer
// gates. Reconcile the append-only operation ledger INSIDE those same snapshots,
// without nesting another host gate. Any original owner beats cold disk bytes;
// a live read must also observe publication uncertainty raised during its IO.
type processReadObservation struct {
	*connectorProcessObservation
	ledger    *SettingsMutationIngress
	operation string
	original  *settingsMutationOperation
	process   *connectorProcessOperation
}

// Caller holds the ledger gate. Only the original, still-running publication
// has a wait witness. A finished attempt without its ACK stays unknown.
func (a *processReadObservation) ledgerCurrentLocked() (<-chan struct{}, error) {
	record := a.ledger.operations[a.operation]
	if a.original == nil && record != nil || a.original != nil &&
		(record != a.original || record.pending || record.process != a.process || a.process == nil || a.process.cancelUnknown || a.process.collectionErr != nil) {
		return nil, &processsvc.Failure{Code: "PROCESS_OUTCOME_UNKNOWN", Unknown: true}
	}
	if a.process != nil && a.process.publishAttempted && a.process.publication == "" {
		if a.process.capturing && a.process.publicationDone != nil {
			return a.process.publicationDone, nil
		}
		return nil, &processsvc.Failure{Code: "PROCESS_OUTCOME_UNKNOWN", Unknown: true}
	}
	return nil, nil
}

func (a *processReadObservation) WithSnapshot(ctx context.Context, participant string, inspect func(port.AccessSnapshot) error) error {
	for {
		var fence error
		var pending <-chan struct{}
		err := a.connectorProcessObservation.WithSnapshot(ctx, participant, func(snapshot port.AccessSnapshot) error {
			a.ledger.mu.Lock()
			defer a.ledger.mu.Unlock()
			pending, fence = a.ledgerCurrentLocked()
			if fence != nil {
				return fence
			}
			if pending != nil {
				return &processsvc.Failure{Code: "PROCESS_PUBLICATION_PENDING"}
			}
			// inspect is value-only. Serialize it with the publication transition;
			// it must run exactly once, never be replayed after waiting.
			return inspect(snapshot)
		})
		// Preserve the ledger classification across the execution adapter.
		if fence != nil {
			return fence
		}
		if pending == nil {
			return err
		}
		if err := a.waitPublication(ctx, pending); err != nil {
			return err
		}
		// Re-enter the SAME admitted lease after releasing all gates to wait.
		// This checks withdrawal/expiry without renewing authority or doing IO.
	}
}

func (a *processReadObservation) waitPublication(ctx context.Context, done <-chan struct{}) error {
	remaining := a.Deadline().Sub(a.clock.Now())
	if remaining <= 0 {
		return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return &processsvc.Failure{Code: "PROCESS_CANCELLED"}
	case <-timer.C:
		return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	case <-done:
		return nil
	}
}

func (a *processReadObservation) check(ctx context.Context) error {
	called := 0
	err := a.WithSnapshot(ctx, a.Binding().ParticipantID, func(port.AccessSnapshot) error { called++; return nil })
	if err != nil {
		return err
	}
	if called != 1 {
		return connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	return nil
}

// Cold lookup belongs only to an already admitted qualified root lifetime whose
// original operation is absent. No disk result can clear a retained owner, claim
// a new operation, renew its execution, settle retirement, or reconstruct a child.
// selectWorkspace is private composition of the fixed original seal; production
// uses only nativeProcessObservation. Request DTOs supply no roots or callbacks.
func (s *computerConnector) observeStoredProcess(ctx context.Context, selected *connectorProcessObservation, operation string, request processct.ReadRequest,
	selectWorkspace func(processsvc.Seal) (processsvc.ObservationWorkspace, error)) (*processct.ReadResponse, error) {
	if s == nil || s.root == nil || s.clock == nil || s.mutations == nil || selected == nil || ctx == nil || selectWorkspace == nil ||
		!validIngressID(operation) || !validIngressID(request.Handle) || request.StdoutOffset > processsvc.MaximumOutput || request.StderrOffset > processsvc.MaximumOutput {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	repository, ok := s.mutations.dependencies.repository.(connectorProcessResults)
	if !ok {
		return nil, connectorProcessRefusal("PROCESS_HANDLE_MISMATCH")
	}
	current := &processReadObservation{connectorProcessObservation: selected, ledger: s.mutations, operation: operation}
	// Gate internal journal IO by the current authenticated READ lifetime. Full
	// original-path and fresh physical authority checks follow the sealed load,
	// before any output or retained metadata may leave the root.
	if err := current.check(ctx); err != nil {
		return nil, err
	}
	scope := selected.ConnectorScope()
	identity := domain.Identity{Scope: domain.ScopeConnector, OperationID: operation,
		OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID}
	result, err := repository.LoadProcessTerminal(ctx, identity)
	if currentErr := current.check(ctx); currentErr != nil {
		return nil, currentErr
	}
	if err != nil {
		return nil, connectorProcessUnknown()
	}
	if result == nil {
		return nil, connectorProcessRefusal("PROCESS_RESULT_UNAVAILABLE")
	}
	if !processsvc.ValidTerminalResult(*result) || result.Intent.OperationID != operation ||
		result.Scope.OwnerID != identity.OwnerID || result.Scope.Host.ProfileID != identity.ProfileID || result.Scope.ComputerID != identity.ComputerID {
		return nil, connectorProcessUnknown()
	}
	workspace, err := selectWorkspace(result.Intent.Seal)
	if err != nil || workspace == nil {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	reader, err := processsvc.NewRetainedObserver(*result, current, workspace, s.clock)
	if err != nil {
		return nil, err
	}
	contract, err := processct.NewRetainedObservation(reader)
	if err != nil {
		return nil, err
	}
	return contract.Read(ctx, request)
}

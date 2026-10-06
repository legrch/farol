package boot

import (
	"context"
	"strconv"
	"sync"

	"github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// The SAME mutation repository supplies the existing process reservation. There
// is no separate process journal, positive admission cache or handle registry.
type connectorProcessRepository interface {
	ConnectorProcessReservation(processsvc.ConnectorReservationScope) (processsvc.Reservation, error)
}

var _ connectorProcessRepository = (*mutationrepo.Repository)(nil)

// Trusted root selects an already qualified producer using this exact lease.
// Selection may inspect native inputs but MUST NOT reserve, spawn or signal.
// It returns a fixed physical workspace observer, never a body-selected lookup.
// No production caller is installed until native confinement/cleanup and durable
// terminal retention are qualified. This join alone does not enable Shell.
type connectorProcessSelection func(context.Context, *execution.Lease) (processsvc.Prepared, processsvc.ObservationWorkspace, error)

type connectorProcessOperation struct {
	contract  *processct.Contract
	workspace processsvc.ObservationWorkspace
}

func connectorProcessRefusal(code string) error {
	return &processct.Failure{Code: code, Outcome: "refused", Retry: "never"}
}

func connectorProcessUnknown() error {
	return &processct.Failure{Code: "PROCESS_OUTCOME_UNKNOWN", Outcome: "outcome_unknown", Retry: "never"}
}

func (s *computerConnector) processSlot(slot *connectorSlot) bool {
	return s != nil && s.root != nil && s.clock != nil && s.mutations != nil && s.mutations.computer == s.root &&
		slot != nil && slot.guard != nil && slot.guard.root == s.root && slot.route != nil && slot.route.issuer != nil &&
		slot.guard.host.ProfileID == s.root.peer.ProfileId
}

// startProcess joins the existing current connector, execution issuer, shared
// operation ledger and durable reservation before ONE selected Start. Requests
// cannot inject a lease, scope, journal or replacement producer. This unexported
// composition method has no wire/MCP registration or native default.
func (s *computerConnector) startProcess(ctx context.Context, slot *connectorSlot, operation, call string, selectLaunch connectorProcessSelection) (*processct.StartResponse, error) {
	if !s.processSlot(slot) || ctx == nil || ctx.Err() != nil || !validIngressID(operation) || !validIngressID(call) || selectLaunch == nil {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	repository, ok := s.mutations.dependencies.repository.(connectorProcessRepository)
	if !ok {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	generation, err := strconv.ParseUint(slot.guard.publication.Generation, 10, 64)
	if err != nil || generation > 9007199254740991 {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	callGeneration, err := strconv.ParseUint(slot.opened.Execution.Generation, 10, 64)
	if err != nil || callGeneration > 9007199254740991 {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	ledger := s.mutations
	ledger.mu.Lock()
	if ledger.frozen || ledger.operations[operation] != nil || len(ledger.operations) >= 4096 {
		ledger.mu.Unlock()
		return nil, connectorProcessUnknown()
	}
	record := &settingsMutationOperation{generation: generation, pending: true, connectorScope: true, process: &connectorProcessOperation{}}
	ledger.operations[operation] = record
	ledger.mu.Unlock()
	finish := func(err error, beforeStart bool) {
		ledger.mu.Lock()
		record.failure, record.pending, record.settled = err, false, beforeStart
		ledger.mu.Unlock()
	}
	if err = s.root.claim(operation); err != nil {
		finish(err, true)
		return nil, err
	}
	lease, err := slot.route.issuer.Admit(ctx, authority.Shell)
	if err != nil {
		finish(err, true)
		return nil, err
	}
	// Copy original provenance once and pass the identical value to both owners.
	selected := processsvc.ConnectorReservationScope{Host: slot.guard.host, OwnerID: s.root.ownerID, ComputerID: s.root.computerID,
		CallID: call, ComputerGeneration: generation, Generation: callGeneration}
	reservation, err := repository.ConnectorProcessReservation(selected)
	if err != nil || reservation == nil {
		err = connectorProcessRefusal("PROCESS_UNAVAILABLE")
		finish(err, true)
		return nil, err
	}
	prepared, workspace, err := selectLaunch(ctx, lease)
	if err != nil || prepared == nil || workspace == nil {
		err = connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
		finish(err, true)
		return nil, err
	}
	service, err := processsvc.NewForConnector(operation, selected, lease, prepared, reservation, &sync.Mutex{}, s.clock)
	if err != nil {
		finish(err, true)
		return nil, err
	}
	contract, err := processct.New(service)
	if err != nil {
		finish(err, true)
		return nil, err
	}
	seal := prepared.Seal()
	ledger.mu.Lock()
	record.workspace, record.path = seal.WorkspaceID, seal.Cwd
	record.process.contract, record.process.workspace = contract, workspace
	// A concurrent retirement that saw pending has already permanently refused.
	// A freeze already visible after selection also prevents entering Start.
	frozen := ledger.frozen
	ledger.mu.Unlock()
	if frozen {
		err = connectorProcessRefusal("PROCESS_UNAVAILABLE")
		finish(err, true)
		return nil, err
	}
	result, err := contract.Start(ctx, processct.StartRequest{OperationID: operation})
	// Once Start was entered, errors can follow durable reservation or dispatch.
	// Even terminal memory observation is not a durable result publication. Keep
	// retirement fenced until the existing repository owns qualified settlement.
	finish(err, false)
	return result, err
}

type connectorProcessObservation struct {
	*execution.Lease
	scope processsvc.ConnectorReadScope
}

func (a *connectorProcessObservation) ConnectorScope() processsvc.ConnectorReadScope { return a.scope }

var _ processsvc.ConnectorObservationAuthority = (*connectorProcessObservation)(nil)

func (s *computerConnector) processObservation(ctx context.Context, slot *connectorSlot) (*connectorProcessObservation, error) {
	if !s.processSlot(slot) || ctx == nil || ctx.Err() != nil {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	generation, err := strconv.ParseUint(slot.guard.publication.Generation, 10, 64)
	if err != nil || generation > 9007199254740991 {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	lease, err := slot.route.issuer.Admit(ctx, authority.Read)
	if err != nil {
		return nil, err
	}
	// Lease.WithSnapshot already enters the current connector's host/settings
	// guard via its existing owner. A second nested host guard would deadlock.
	return &connectorProcessObservation{Lease: lease, scope: processsvc.ConnectorReadScope{
		Host: slot.guard.host, OwnerID: s.root.ownerID, ComputerID: s.root.computerID, ComputerGeneration: generation}}, nil
}

func (s *computerConnector) observeProcess(ctx context.Context, slot *connectorSlot, operation string, request processct.ReadRequest) (*processct.ReadResponse, error) {
	if !validIngressID(operation) {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	current, err := s.processObservation(ctx, slot)
	if err != nil {
		return nil, err
	}
	ledger := s.mutations
	ledger.mu.Lock()
	record := ledger.operations[operation]
	if record == nil || record.process == nil {
		ledger.mu.Unlock()
		// Disk intent cannot restore a Child. No cold lookup or inferred absence.
		return nil, connectorProcessRefusal("PROCESS_HANDLE_MISMATCH")
	}
	if record.pending {
		ledger.mu.Unlock()
		return nil, connectorProcessUnknown()
	}
	contract, workspace := record.process.contract, record.process.workspace
	ledger.mu.Unlock()
	if contract == nil || workspace == nil {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	observer, err := contract.ConnectorObserver(current, workspace)
	if err != nil {
		return nil, err
	}
	return observer.Read(ctx, request)
}

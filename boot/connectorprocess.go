package boot

import (
	"context"
	"errors"
	"strconv"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/app/services/output"
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
// Only independently selected native support supplies this caller. This join
// alone grants no workspace access or native/release acceptance.
type connectorProcessSelection func(context.Context, *execution.Lease) (processsvc.Prepared, processsvc.ObservationWorkspace, error)

type connectorProcessOperation struct {
	owner            *connectorSlot
	origin           processsvc.ConnectorReservationScope
	contract         *processct.Contract
	service          *processsvc.Service
	workspace        processsvc.ObservationWorkspace
	capturing        bool
	publishAttempted bool
	result           *processsvc.TerminalResult
	publication      string
	publicationDone  chan struct{}
	cancelling       bool
	cancelUnknown    bool
	cancelDone       chan struct{}
	collectionDone   chan struct{}
	collectionErr    error
	auditCommand     output.Command
}

func connectorProcessRefusal(code string) error {
	return &processct.Failure{Code: code, Outcome: "refused", Retry: "never"}
}

func connectorProcessUnknown() error {
	return &processct.Failure{Code: "PROCESS_OUTCOME_UNKNOWN", Outcome: "outcome_unknown", Retry: "never"}
}

// Preparation never discloses an underlying message, command, path or source.
// Only these closed facts can cross the selection wrappers. Uncertain outcomes
// remain uncertain, and no classification grants permission to retry.
func connectorPreparationFailure(err error) error {
	code, unknown := "PROCESS_PREPARATION_UNAVAILABLE", false
	var contract *processct.Failure
	var service *processsvc.Failure
	var denied *authority.Failure
	var native *processsvc.NativeFailure
	switch {
	case errors.As(err, &contract) && contract != nil:
		code, unknown = contract.Code, contract.Outcome == "outcome_unknown"
	case errors.As(err, &service) && service != nil:
		code, unknown = service.Code, service.Unknown
	case errors.As(err, &denied) && denied != nil:
		code = denied.Code
	case errors.As(err, &native) && native != nil:
		unknown = native.Unknown
		if native.FilesystemUnsupported {
			code = "PROCESS_FILESYSTEM_UNSUPPORTED"
		}
		if unknown {
			code = "PROCESS_OUTCOME_UNKNOWN"
		}
	case errors.Is(err, context.DeadlineExceeded):
		code = "PROCESS_PREPARATION_DEADLINE"
	case errors.Is(err, context.Canceled):
		code = "PROCESS_CANCELLED"
	}
	switch code {
	case "PROCESS_PREPARATION_UNAVAILABLE", "PROCESS_PREPARATION_POLICY_MISMATCH", "PROCESS_FILESYSTEM_UNSUPPORTED",
		"PROCESS_PREPARATION_WORKSPACE_STALE", "PROCESS_PREPARATION_SCOPE_REFUSED",
		"PROCESS_PREPARATION_DEADLINE", "PROCESS_PREPARATION_AUTHORIZATION_CHANGED",
		"PROCESS_CANCELLED", "PROCESS_NATIVE_REFUSED", "PROCESS_PREPARATION_UNKNOWN", "PROCESS_OUTCOME_UNKNOWN",
		"AUTHORITY_EXPIRED", "AUTHORITY_OWNER_MISMATCH", "AUTHORITY_TASK_MISMATCH",
		"AUTHORITY_COMPUTER_MISMATCH", "AUTHORITY_INFLATION_DENIED", "AUTHORITY_NETWORK_DENIED",
		"AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_COMMAND_DENIED", "AUTHORITY_PATH_DENIED",
		"AUTHORITY_MUTATION_OWNERSHIP_DENIED", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
		"COMPUTER_PARTICIPANT_NOT_FOUND", "COMPUTER_APPROVAL_NOT_FOUND", "WORKSPACE_REQUEST_CANCELLED":
	default:
		code = "PROCESS_PREPARATION_UNAVAILABLE"
		if unknown {
			code = "PROCESS_OUTCOME_UNKNOWN"
		}
	}
	outcome := "refused"
	if unknown {
		outcome = "outcome_unknown"
	}
	return &processct.Failure{Code: code, Outcome: outcome, Retry: "never"}
}

func (s *computerConnector) processSlot(slot *connectorSlot) bool {
	return s != nil && s.root != nil && s.clock != nil && s.mutations != nil && s.mutations.computer == s.root &&
		slot != nil && slot.guard != nil && slot.guard.root == s.root && slot.route != nil && slot.route.issuer != nil &&
		slot.guard.host.ProfileID == s.root.peer.ProfileId
}

// startProcess joins the existing current connector, execution issuer, shared
// operation ledger and durable reservation before ONE selected Start. Requests
// cannot inject a lease, scope, journal or replacement producer. This unexported
// composition method is shared by the optional wire adapter; startup without
// qualified native support supplies no process producer.
func (s *computerConnector) startProcess(ctx context.Context, slot *connectorSlot, operation, call string, selectLaunch connectorProcessSelection) (*processct.StartResponse, error) {
	return s.startProcessWithAudit(ctx, slot, operation, call, selectLaunch, output.Command{})
}

func (s *computerConnector) startProcessWithAudit(ctx context.Context, slot *connectorSlot, operation, call string, selectLaunch connectorProcessSelection, command output.Command) (*processct.StartResponse, error) {
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
	if ledger.frozen || ledger.processDraining || ledger.recoveryReserved || ledger.operations[operation] != nil || len(ledger.operations) >= 4096 {
		ledger.mu.Unlock()
		return nil, connectorProcessUnknown()
	}
	record := &settingsMutationOperation{generation: generation, pending: true, connectorScope: true, process: &connectorProcessOperation{owner: slot, collectionDone: make(chan struct{}), auditCommand: command}}
	ledger.operations[operation] = record
	ledger.mu.Unlock()
	finish := func(err error, beforeStart bool) {
		ledger.mu.Lock()
		record.failure, record.pending, record.settled = err, false, beforeStart
		if beforeStart {
			close(record.process.collectionDone)
		}
		ledger.mu.Unlock()
	}
	if err = s.root.claim(operation); err != nil {
		finish(err, true)
		return nil, err
	}
	lease, err := slot.route.admit(ctx, authority.Shell)
	if err != nil {
		finish(err, true)
		return nil, err
	}
	// Copy original provenance once and pass the identical value to both owners.
	selected := processsvc.ConnectorReservationScope{Host: slot.guard.host, OwnerID: s.root.ownerID, ComputerID: s.root.computerID,
		CallID: call, ComputerGeneration: generation, Generation: callGeneration}
	ledger.mu.Lock()
	record.process.origin = selected
	ledger.mu.Unlock()
	reservation, err := repository.ConnectorProcessReservation(selected)
	if err != nil || reservation == nil {
		err = connectorProcessRefusal("PROCESS_UNAVAILABLE")
		finish(err, true)
		return nil, err
	}
	prepared, workspace, err := selectLaunch(ctx, lease)
	if err != nil || prepared == nil || workspace == nil {
		err = connectorPreparationFailure(err)
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
	record.process.contract, record.process.service, record.process.workspace = contract, service, workspace
	// A concurrent retirement that saw pending has already permanently refused.
	// A freeze already visible after selection also prevents entering Start.
	frozen := ledger.frozen || ledger.processDraining || ledger.recoveryReserved
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
	// The original child remains owned even when final Start disclosure fails.
	// Its backend-lifetime collector never renews execution or external READ.
	go s.collectProcess(record, operation)
	return result, err
}

type connectorProcessObservation struct {
	*execution.Lease
	scope processsvc.ConnectorReadScope
	clock port.Clock
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
	lease, err := slot.route.admit(ctx, authority.Read)
	if err != nil {
		return nil, err
	}
	// Lease.WithSnapshot already enters the current connector's host/settings
	// guard via its existing owner. A second nested host guard would deadlock.
	return &connectorProcessObservation{Lease: lease, clock: s.clock, scope: processsvc.ConnectorReadScope{
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
	if record == nil {
		ledger.mu.Unlock()
		return s.observeStoredProcess(ctx, current, operation, request, nativeProcessObservation)
	}
	if record.process == nil {
		ledger.mu.Unlock()
		return nil, connectorProcessRefusal("PROCESS_HANDLE_MISMATCH")
	}
	if record.pending || record.process.cancelUnknown || record.process.collectionErr != nil {
		ledger.mu.Unlock()
		return nil, connectorProcessUnknown()
	}
	retained := record.process
	contract, workspace := retained.contract, retained.workspace
	ledger.mu.Unlock()
	if contract == nil || workspace == nil {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	guarded := &processReadObservation{connectorProcessObservation: current, ledger: ledger,
		operation: operation, original: record, process: retained}
	observer, err := contract.ConnectorObserver(guarded, workspace)
	if err != nil {
		return nil, err
	}
	return observer.Read(ctx, request)
}

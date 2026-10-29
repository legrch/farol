package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// SettingsMutationIngress composes a qualified exclusive journal/native owner.
// Its bounded operation ledger also owns prepared external connector attempts;
// closing a connector must not discard their uncertainty or retirement fences.
// It never provisions/migrates storage or translates legacy Settings Task IDs.
// NativeRuntime owns this journal only in a qualified version 2 profile.
// The host route and legacy writer cutover have separate acceptance gates.
type SettingsMutationIngress struct {
	mu              sync.Mutex
	computer        *ComputerIngress
	dependencies    computerMutationDependencies
	operations      map[string]*settingsMutationOperation
	frozen          bool
	processDraining bool
	stagePending    bool
	stageDone       chan struct{}
	stageClosed     bool
	stageLifetime   context.Context
	stageBaseline   bool
	stageOwner      *computerStageOwner
	retirementErr   error
	// Temporary admission exclusion for the existing connector's recovery Open.
	// Unlike retirement this never freezes the ledger or discards its records.
	recoveryReserved bool
}
type settingsMutationOperation struct {
	workspace, path string
	generation      uint64
	pending         bool
	settled         bool
	contract        *mutationct.OwnerContract
	connector       *mutationsvc.ConnectorService
	process         *connectorProcessOperation
	connectorScope  bool
	stageScratch    bool // Set only by the trusted self-test admission owner.
	stageAttempted  bool // Sticky once the original staging attempt is entered.
	failure         error
}

func NewSettingsMutationIngress(computer *ComputerIngress, journal *mutationrepo.Repository, native *filesystem.Mutable) (*SettingsMutationIngress, error) {
	if journal == nil || native == nil {
		return nil, computerUnavailable()
	}
	return settingsMutationIngress(computer, computerMutationDependencies{repository: journal, native: native, digester: filesystem.Digester{}})
}
func settingsMutationIngress(computer *ComputerIngress, d computerMutationDependencies) (*SettingsMutationIngress, error) {
	if computer == nil || !validIngressID(computer.peer.ProfileId) || !validIngressID(computer.ownerID) || !validIngressID(computer.computerID) || d.repository == nil || d.native == nil || d.digester == nil {
		return nil, computerUnavailable()
	}
	return &SettingsMutationIngress{computer: computer, dependencies: d, operations: make(map[string]*settingsMutationOperation)}, nil
}
func (s *SettingsMutationIngress) selection(operation string, generation uint64) mutationsvc.OwnerSelection {
	return mutationsvc.OwnerSelection{OperationID: operation, OwnerID: s.computer.ownerID, ProfileID: s.computer.peer.ProfileId, ComputerID: s.computer.computerID, ComputerGeneration: generation}
}
func (s *SettingsMutationIngress) edit(ctx context.Context, operation string, in wire.ComputerSettingsEditRequest) (*wire.ComputerSettingsMutationResponse, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ComputerSettingsEditRequest", in) != nil || len(in.Edits) < 1 || len(in.Edits) > 256 {
		return nil, mutationInvalid()
	}
	// Refuse before renewal can wait on root.effects held by recovery Open.
	// Recheck atomically with inserting the operation below.
	s.mu.Lock()
	reserved := s.recoveryReserved
	s.mu.Unlock()
	if reserved {
		return nil, errors.New("settings_mutation_attempt_consumed")
	}
	if err := s.computer.refreshCurrentApproval(ctx); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(in)
	if err != nil || len(raw) > 512*1024 {
		return nil, mutationInvalid()
	}
	generation, err := strconv.ParseUint(in.Publication.Generation, 10, 64)
	if err != nil || generation > 9007199254740991 {
		return nil, mutationInvalid()
	}
	s.mu.Lock()
	if s.frozen || s.recoveryReserved || s.operations[operation] != nil || len(s.operations) >= 4096 {
		s.mu.Unlock()
		return nil, errors.New("settings_mutation_attempt_consumed")
	}
	record := &settingsMutationOperation{workspace: in.WorkspaceId, path: in.RelativePath, generation: generation, pending: true}
	s.operations[operation] = record
	s.mu.Unlock()
	finish := func(contract *mutationct.OwnerContract, err error, settled bool) {
		s.mu.Lock()
		record.contract = contract
		record.failure = err
		record.pending = false
		record.settled = settled
		s.mu.Unlock()
	}
	if err = s.computer.claim(operation); err != nil {
		finish(nil, err, true)
		return nil, err
	}
	edits := make([]mutationct.TextEdit, len(in.Edits))
	for i, e := range in.Edits {
		edits[i] = mutationct.TextEdit{OldText: e.OldText, NewText: e.NewText}
	}
	request := mutationct.OwnerRequest{WorkspaceID: in.WorkspaceId, Operation: mutationct.Edit{RelativePath: in.RelativePath, ExpectedSHA256: in.ExpectedSHA256, Edits: edits}}
	if err = mutationct.ValidateOwnerRequest(request); err != nil {
		finish(nil, err, true)
		return nil, err
	}
	current, err := s.computer.settingsAuthority(ctx, in.Publication)
	if err != nil {
		finish(nil, err, true)
		return nil, err
	}
	var clock computerport.Clock = s.computer.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	service, err := mutationsvc.NewForOwnerExecution(ctx, s.selection(operation, generation), current, s.dependencies.repository, s.dependencies.native, s.dependencies.digester, &sync.Mutex{}, clock)
	if err != nil {
		finish(nil, err, true)
		return nil, err
	}
	contract := mutationct.NewOwnerExecution(service)
	out, err := contract.Execute(ctx, request)
	if err != nil {
		finish(contract, err, false)
		return nil, err
	}
	result, err := settingsMutationResult(operation, in.WorkspaceId, in.RelativePath, generation, out)
	finish(contract, err, settledSettingsMutation(result, err))
	return result, err
}
func (s *SettingsMutationIngress) observe(ctx context.Context, in wire.ComputerSettingsMutationRead) (*wire.ComputerSettingsMutationResponse, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || validateIngress("ComputerSettingsMutationRead", in) != nil {
		return nil, mutationInvalid()
	}
	generation, err := strconv.ParseUint(in.ComputerGeneration, 10, 64)
	if err != nil || generation > 9007199254740991 {
		return nil, mutationInvalid()
	}
	s.mu.Lock()
	record := s.operations[in.OperationId]
	var contract *mutationct.OwnerContract
	if record != nil {
		if record.connectorScope || record.workspace != in.WorkspaceId || record.path != in.RelativePath || record.generation != generation {
			s.mu.Unlock()
			return nil, mutationInvalid()
		}
		if record.pending {
			s.mu.Unlock()
			return nil, &mutationct.Failure{Code: "COMPUTER_MUTATION_IN_PROGRESS", Source: "operation-store", Retry: "never"}
		}
		contract, err = record.contract, record.failure
	}
	s.mu.Unlock()
	if contract == nil {
		if record != nil {
			return nil, err
		}
		// Rejoin observes the exact original identity only. No current write
		// publication/lease or original mutation text is required or recreated.
		reader, err := mutationsvc.NewOwnerObserver(s.selection(in.OperationId, generation), s.dependencies.repository)
		if err != nil {
			return nil, err
		}
		contract = mutationct.NewOwnerObservation(reader)
	}
	out, err := contract.Observe(ctx, mutationct.OwnerObservation{WorkspaceID: in.WorkspaceId, RelativePath: in.RelativePath})
	if err != nil {
		return nil, err
	}
	result, err := settingsMutationResult(in.OperationId, in.WorkspaceId, in.RelativePath, generation, out)
	if record != nil && settledSettingsMutation(result, err) {
		s.mu.Lock()
		record.settled = true
		s.mu.Unlock()
	}
	return result, err
}

func settledSettingsMutation(result *wire.ComputerSettingsMutationResponse, err error) bool {
	return err == nil && result != nil && result.Publication == "durable" && (result.Phase == "completed" || result.Phase == "failed")
}

// freezeForRetirement blocks new admissions before judging this actual owner.
// Pending/unknown publication and memory-only results cannot be replaced by a
// fresh journal owner, even if visible disk bytes later look complete. A known
// durable result remains observable after clean restart; delivery ACK is separate.
func (s *SettingsMutationIngress) freezeForRetirement() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen {
		return s.retirementErr
	}
	s.frozen = true
	if s.stagePending {
		s.retirementErr = &mutationct.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
		return s.retirementErr
	}
	for _, operation := range s.operations {
		if operation.pending || !operation.settled {
			s.retirementErr = &mutationct.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
			return s.retirementErr
		}
	}
	return nil
}

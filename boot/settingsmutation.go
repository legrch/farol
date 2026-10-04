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
// It never provisions/migrates storage or translates legacy Settings Task IDs.
// NativeRuntime activation and the old writer's cutover are separate gates.
type SettingsMutationIngress struct {
	mu           sync.Mutex
	computer     *ComputerIngress
	dependencies computerMutationDependencies
	operations   map[string]*settingsMutationOperation
}
type settingsMutationOperation struct {
	workspace, path string
	generation      uint64
	pending         bool
	contract        *mutationct.OwnerContract
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
	raw, err := json.Marshal(in)
	if err != nil || len(raw) > 512*1024 {
		return nil, mutationInvalid()
	}
	generation, err := strconv.ParseUint(in.Publication.Generation, 10, 64)
	if err != nil || generation > 9007199254740991 {
		return nil, mutationInvalid()
	}
	s.mu.Lock()
	if s.operations[operation] != nil || len(s.operations) >= 4096 {
		s.mu.Unlock()
		return nil, errors.New("settings_mutation_attempt_consumed")
	}
	record := &settingsMutationOperation{workspace: in.WorkspaceId, path: in.RelativePath, generation: generation, pending: true}
	s.operations[operation] = record
	s.mu.Unlock()
	finish := func(contract *mutationct.OwnerContract, err error) {
		s.mu.Lock()
		record.contract = contract
		record.failure = err
		record.pending = false
		s.mu.Unlock()
	}
	if err = s.computer.claim(operation); err != nil {
		finish(nil, err)
		return nil, err
	}
	current, err := s.computer.settingsAuthority(ctx, in.Publication)
	if err != nil {
		finish(nil, err)
		return nil, err
	}
	var clock computerport.Clock = s.computer.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	service, err := mutationsvc.NewForOwnerExecution(ctx, s.selection(operation, generation), current, s.dependencies.repository, s.dependencies.native, s.dependencies.digester, &sync.Mutex{}, clock)
	if err != nil {
		finish(nil, err)
		return nil, err
	}
	contract := mutationct.NewOwnerExecution(service)
	edits := make([]mutationct.TextEdit, len(in.Edits))
	for i, e := range in.Edits {
		edits[i] = mutationct.TextEdit{OldText: e.OldText, NewText: e.NewText}
	}
	out, err := contract.Execute(ctx, mutationct.OwnerRequest{WorkspaceID: in.WorkspaceId, Operation: mutationct.Edit{RelativePath: in.RelativePath, ExpectedSHA256: in.ExpectedSHA256, Edits: edits}})
	finish(contract, err)
	if err != nil {
		return nil, err
	}
	return settingsMutationResult(operation, in.WorkspaceId, in.RelativePath, generation, out)
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
		if record.workspace != in.WorkspaceId || record.path != in.RelativePath || record.generation != generation {
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
	return settingsMutationResult(in.OperationId, in.WorkspaceId, in.RelativePath, generation, out)
}

package boot

import (
	"context"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// newConnectorSelfTest selects only the current already-qualified connector.
// It performs no journal write, approval renewal, or native filesystem effect.
// The caller must retain the returned execution for its entire lifetime.
func (s *computerConnector) newConnectorSelfTest(ctx context.Context, slot *connectorSlot, workspace, operation string, publication wire.ComputerAuthorityPublication) (*durableSelfTestExecution, error) {
	ids, valid := selfTestIDsV3(operation)
	if s == nil || s.root == nil || s.mutations == nil || s.mutations.computer != s.root || slot == nil || slot.guard == nil || !valid || !state.Identifier(workspace, 120) || slot.guard.publication != publication {
		return nil, computerUnavailable()
	}
	if err := s.checkMutationSlot(ctx, slot, slot.opened.Execution); err != nil {
		return nil, err
	}
	generation, err := strconv.ParseUint(publication.Generation, 10, 64)
	if err != nil || generation > state.MaxSafeInteger || strconv.FormatUint(generation, 10) != publication.Generation {
		return nil, mutationInvalid()
	}
	if _, err := s.root.settingsAuthority(ctx, publication); err != nil {
		return nil, err
	}
	repo, ok := s.mutations.dependencies.repository.(port.SelfTestRepository)
	if !ok || repo == nil {
		return nil, computerUnavailable()
	}
	binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: operation, OwnerID: s.root.ownerID, ProfileID: s.root.peer.ProfileId, ComputerID: s.root.computerID}, WorkspaceID: workspace, ComputerGeneration: generation, Version: 3}
	if !binding.Valid() {
		return nil, mutationInvalid()
	}
	plan := &connectorSelfTestPlan{connector: s, slot: slot, workspace: workspace, publication: publication, ids: ids}
	preflight := func(ctx context.Context) error {
		if err := s.checkMutationSlot(ctx, slot, slot.opened.Execution); err != nil {
			return err
		}
		_, err := s.root.settingsAuthority(ctx, publication)
		return err
	}
	return &durableSelfTestExecution{binding: binding, repository: repo, preflight: preflight, gate: &s.mutations.selfTestParent, ledger: s.mutations, execution: &selfTestExecution{owner: plan, version: 3}, originSlot: slot, originPublication: publication}, nil
}

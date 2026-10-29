package boot

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// observeConnectorSelfTest reads only the original parent. It cannot create,
// restore, resume or repeat a child; missing and Prepared are unknown. The
// current connector read lease is checked before and after repository IO.
func (s *computerConnector) observeConnectorSelfTest(ctx context.Context, slot *connectorSlot, binding state.SelfTestBinding) (selfTestReport, error) {
	unknown := selfTestReport{Status: "unknown"}
	if s == nil || s.root == nil || s.mutations == nil || s.mutations.computer != s.root || slot == nil || !binding.Valid() || binding.Identity.OwnerID != s.root.ownerID || binding.Identity.ProfileID != s.root.peer.ProfileId || binding.Identity.ComputerID != s.root.computerID {
		return unknown, mutationInvalid()
	}
	if err := s.checkMutationSlot(ctx, slot, slot.opened.Execution); err != nil {
		return unknown, err
	}
	repo, ok := s.mutations.dependencies.repository.(port.SelfTestRepository)
	if !ok || repo == nil {
		return unknown, computerUnavailable()
	}
	guard, err := s.mutationObservation(ctx, slot)
	if err != nil {
		return unknown, err
	}
	suffix := "-st1-write"
	if binding.Version == 2 {
		suffix = "-st2-write"
	}
	child := state.Identity{Scope: state.ScopeConnector, OperationID: binding.Identity.OperationID + suffix, OwnerID: binding.Identity.OwnerID, ProfileID: binding.Identity.ProfileID, ComputerID: binding.Identity.ComputerID}
	path := state.ScratchPath(binding.Identity.OperationID) + "/check.txt"
	check := func() error {
		return guard.WithMutationObservation(ctx, child, binding.WorkspaceID, path, func() error { return nil })
	}
	if err := check(); err != nil {
		return unknown, err
	}
	record, err := repo.LoadSelfTest(ctx, binding)
	if err != nil {
		return unknown, err
	}
	var disclosed selfTestReport
	err = guard.WithMutationObservation(ctx, child, binding.WorkspaceID, path, func() error {
		if record == nil {
			disclosed = unknown
			return nil
		}
		if record.Binding() != binding {
			return computerUnavailable()
		}
		disclosed = observeSelfTestState(record)
		return nil
	})
	if err != nil {
		return unknown, err
	}
	return disclosed, nil
}

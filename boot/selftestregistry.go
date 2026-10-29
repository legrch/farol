package boot

import (
	"context"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

// selfTestRegistry retains the original in-memory owner across duplicate IPC
// calls. It is bounded and never turns a lost admission into a new execution.
// Durable observation after restart is a separate read-only path.
type selfTestRegistry struct {
	mu      sync.Mutex
	entries map[string]*durableSelfTestExecution
}

func (s *computerConnector) selectSelfTest(ctx context.Context, slot *connectorSlot, workspace, operation string, publication wire.ComputerAuthorityPublication) (*durableSelfTestExecution, error) {
	selected, err := s.newConnectorSelfTest(ctx, slot, workspace, operation, publication)
	if err != nil {
		return nil, err
	}
	r := &s.selfTests
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.entries[operation]; existing != nil {
		if existing.binding != selected.binding {
			return nil, mutationInvalid()
		}
		return existing, nil
	}
	if len(r.entries) >= 256 {
		return nil, computerUnavailable()
	}
	if r.entries == nil {
		r.entries = make(map[string]*durableSelfTestExecution)
	}
	r.entries[operation] = selected
	return selected, nil
}

// Only the owner created by this process's original reservation can consume
// the in-memory permit. A new factory selection never reconstructs it.
func (s *computerConnector) reservedSelfTest(slot *connectorSlot, workspace, operation string, publication wire.ComputerAuthorityPublication) (*durableSelfTestExecution, error) {
	if s == nil || slot == nil || slot.guard == nil || slot.guard.publication != publication {
		return nil, mutationInvalid()
	}
	s.selfTests.mu.Lock()
	defer s.selfTests.mu.Unlock()
	execution := s.selfTests.entries[operation]
	if execution == nil || execution.binding.Identity.OperationID != operation || execution.binding.WorkspaceID != workspace || decimal(execution.binding.ComputerGeneration) != publication.Generation || execution.execution == nil || execution.originSlot != slot || execution.originPublication != publication {
		return nil, computerUnavailable()
	}
	return execution, nil
}

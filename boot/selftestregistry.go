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

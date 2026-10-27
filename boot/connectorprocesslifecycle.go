package boot

import (
	"context"

	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
)

// One waiter belongs to the original operation entry. It waits the SAME child's
// existing completion notification, not a PID, a new command or another Wait.
// The backend lifetime survives a request timeout and connector replacement.
// No external READ, authority renewal, polling or automatic cancellation occurs.
func (s *computerConnector) collectProcess(record *settingsMutationOperation, operation string) {
	ledger := s.mutations
	p := record.process
	var err error
	defer func() {
		ledger.mu.Lock()
		if err != nil && !record.settled {
			p.collectionErr = connectorProcessUnknown()
			record.failure = p.collectionErr
		}
		close(p.collectionDone)
		ledger.mu.Unlock()
	}()
	if err = p.service.WaitForCompletion(s.lifetime); err != nil {
		return
	}
	// Claiming capture waits an original in-flight cancel ACK under the same
	// ledger transition; there is no gap in which a new cancel can slip past it.
	_, err = s.retainProcessResult(s.lifetime, operation, record, p.service.CaptureOwnedTerminal)
}

// Drain stops further process admissions, then awaits existing preservation
// attempts before the journal's final freeze verdict. It neither retries a
// publication nor signals a process. A running/unknown execution owner or lost
// ACK remains a failed retirement, even if later disk bytes look complete.
// Known supervisor exit preserves its result but cannot settle unverified group
// cleanup. A published result is never rewritten to manufacture settlement.
func (s *computerConnector) drainProcessesForRetirement(ctx context.Context) error {
	if s == nil || s.mutations == nil {
		return nil
	}
	unknown := func() error {
		return &mutationct.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
	}
	ledger := s.mutations
	fence := func() error {
		ledger.mu.Lock()
		defer ledger.mu.Unlock()
		ledger.frozen = true
		if ledger.retirementErr == nil {
			ledger.retirementErr = unknown()
		}
		return ledger.retirementErr
	}
	ledger.mu.Lock()
	if ledger.retirementErr != nil {
		err := ledger.retirementErr
		ledger.mu.Unlock()
		return err
	}
	ledger.processDraining = true
	var pending []<-chan struct{}
	for _, record := range ledger.operations {
		if record.process == nil {
			continue
		}
		if record.process.collectionDone == nil {
			ledger.mu.Unlock()
			return fence()
		}
		pending = append(pending, record.process.collectionDone)
	}
	ledger.mu.Unlock()
	if ctx == nil || ctx.Err() != nil {
		return fence()
	}
	for _, done := range pending {
		select {
		case <-done:
		case <-ctx.Done():
			return fence()
		}
	}
	ledger.mu.Lock()
	for _, record := range ledger.operations {
		if record.process != nil && (record.pending || !record.settled || record.process.collectionErr != nil || record.process.cancelling || record.process.cancelUnknown) {
			ledger.mu.Unlock()
			return fence()
		}
	}
	ledger.mu.Unlock()
	return nil
}

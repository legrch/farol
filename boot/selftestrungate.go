package boot

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// selfTestRunLease is an internal exclusion token, not authority to touch a
// workspace. The selected operations still acquire their ordinary authority.
// This first slice can abandon only before any operation has been admitted.
type selfTestRunLease struct {
	ledger               *SettingsMutationIngress
	operation, workspace string
	ctx                  context.Context
	cancel               context.CancelFunc
	stop                 func() bool
	autoStop             func() bool
	released             chan struct{}
	active               bool          // protected by ledger.mu
	callDone             chan struct{} // protected by ledger.mu
	cleanupStarted       bool          // protected by ledger.mu; never retried
}

func (s *SettingsMutationIngress) beginSelfTestRun(ctx context.Context, operation, workspace string) (*selfTestRunLease, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !mutation.ScratchLeaf(mutation.ScratchPath(operation)) || !mutation.Identifier(workspace, 120) {
		return nil, computerUnavailable()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.stageBaseline || s.stageOwner == nil || s.stageLifetime == nil || s.stageLifetime.Err() != nil || s.operations == nil || s.operations[operation] != nil || s.selfTestRun != nil || s.scratchPreflight != nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil || ctx.Err() != nil {
		return nil, computerUnavailable()
	}
	for _, previous := range s.operations {
		if !stagingPriorEligible(previous) {
			return nil, computerUnavailable()
		}
	}
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.stageLifetime, cancel)
	run := &selfTestRunLease{ledger: s, operation: operation, workspace: workspace, ctx: bounded, cancel: cancel, stop: stop, released: make(chan struct{})}
	s.selfTestRun = run
	run.autoStop = context.AfterFunc(bounded, func() { _ = run.abandonUnstarted() })
	return run, nil
}

// abandonUnstarted never removes a fixture or settles a journal entry. A run
// that reached admission retains its fence until an actual cleanup owner exists.
func (r *selfTestRunLease) abandonUnstarted() error {
	if r == nil || r.ledger == nil {
		return computerUnavailable()
	}
	s := r.ledger
	s.mu.Lock()
	defer s.mu.Unlock()
	if !r.abandonUnstartedLocked() {
		return computerUnavailable()
	}
	return nil
}

func (r *selfTestRunLease) abandonUnstartedLocked() bool {
	s := r.ledger
	if s.selfTestRun != r || r.active || s.stagePending || s.operations[r.operation] != nil {
		return false
	}
	s.selfTestRun = nil
	close(r.released)
	r.stop()
	if r.autoStop != nil {
		r.autoStop()
	}
	r.cancel()
	return true
}

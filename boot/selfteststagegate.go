package boot

import (
	"context"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"sync"
)

// selfTestStageLease retains a single attempt's admission gate until Release.
// Native use is synchronous and one-shot; cancellation never releases the gate.
type selfTestStageLease struct {
	mu          sync.Mutex
	ledger      *SettingsMutationIngress
	runNative   func(context.Context, func(context.Context, int, NativeRoot) error) error
	ctx         context.Context
	cancel      context.CancelFunc
	stop        func() bool
	gateDone    chan struct{}
	runDone     chan struct{}
	releaseDone chan struct{}
	releasing   bool
}

// beginSelfTestStage only reserves the gate. It does not authorize, admit or
// execute a mutation. The caller must already own the original admitted attempt.
func (s *SettingsMutationIngress) beginSelfTestStage(ctx context.Context, operation string) (*selfTestStageLease, error) {
	return s.beginSelfTestStageBound(ctx, operation, "")
}

func (s *SettingsMutationIngress) beginSelfTestStageForWorkspace(ctx context.Context, operation, workspace string) (*selfTestStageLease, error) {
	if !mutation.Identifier(workspace, 120) {
		return nil, computerUnavailable()
	}
	return s.beginSelfTestStageBound(ctx, operation, workspace)
}

func (s *SettingsMutationIngress) beginSelfTestStageBound(ctx context.Context, operation, workspace string) (*selfTestStageLease, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !mutation.ScratchLeaf(mutation.ScratchPath(operation)) {
		return nil, computerUnavailable()
	}
	s.mu.Lock()
	if !s.stageBaseline || s.stageOwner == nil || s.stageLifetime == nil || s.stageLifetime.Err() != nil || s.operations == nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.retirementErr != nil || s.recoveryReserved || ctx.Err() != nil {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	own := s.operations[operation]
	if own == nil || (workspace != "" && own.workspace != workspace) || !own.stageScratch || own.stageAttempted || !own.pending || own.settled || own.process != nil || own.path != mutation.ScratchPath(operation) {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	for key, record := range s.operations {
		if key != operation && (record == nil || ((record.process != nil || record.stageScratch) && (record.pending || !record.settled))) {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
	}
	own.stageAttempted = true
	s.stagePending = true
	done := make(chan struct{})
	s.stageDone = done
	owner, lifetime := s.stageOwner, s.stageLifetime
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(lifetime, cancel)
	s.mu.Unlock()
	return &selfTestStageLease{ledger: s, runNative: owner.run, ctx: bounded, cancel: cancel, stop: stop, gateDone: done}, nil
}

// run joins descriptor closure and the original profile recheck. It may be
// entered once, and cannot race a release or be reentered.
func (l *selfTestStageLease) run(use func(context.Context, int, NativeRoot) error) error {
	if l == nil || use == nil {
		return computerUnavailable()
	}
	l.mu.Lock()
	if l.releasing || l.runDone != nil {
		l.mu.Unlock()
		return computerUnavailable()
	}
	done := make(chan struct{})
	l.runDone = done
	l.mu.Unlock()
	defer close(done)
	return l.runNative(l.ctx, use)
}

// release is idempotent and joins a running native attempt. The owner calls it
// only after terminal Save; it never executes native work or journal writes.
func (l *selfTestStageLease) release() {
	if l == nil {
		return
	}
	l.mu.Lock()
	if l.releaseDone != nil {
		done := l.releaseDone
		l.mu.Unlock()
		<-done
		return
	}
	done := make(chan struct{})
	l.releaseDone, l.releasing = done, true
	runDone := l.runDone
	l.mu.Unlock()
	if runDone != nil {
		<-runDone
	}
	l.stop()
	l.cancel()
	l.ledger.mu.Lock()
	l.ledger.stagePending = false
	l.ledger.stageDone = nil
	close(l.gateDone)
	l.ledger.mu.Unlock()
	close(done)
}

// withSelfTestStage remains a synchronous fixture for the existing gate tests.
func (s *SettingsMutationIngress) withSelfTestStage(ctx context.Context, operation string, use func(context.Context, int, NativeRoot) error, finish func(error) error) error {
	if use == nil || finish == nil {
		return computerUnavailable()
	}
	lease, err := s.beginSelfTestStage(ctx, operation)
	if err != nil {
		return err
	}
	defer lease.release()
	return finish(lease.run(use))
}

// waitSelfTestStage joins terminal persistence after the native owner has
// returned. It never holds the ledger lock while waiting.
func (s *SettingsMutationIngress) waitSelfTestStage() {
	if s == nil {
		return
	}
	s.mu.Lock()
	done := s.stageDone
	s.mu.Unlock()
	if done != nil {
		<-done
	}
}

// closeSelfTestStageAdmission must precede the owner join. The same lock
// makes a later begin impossible before waitSelfTestStage observes stageDone.
func (s *SettingsMutationIngress) closeSelfTestStageAdmission() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.stageClosed = true
	s.mu.Unlock()
}

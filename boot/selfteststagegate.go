package boot

import (
	"context"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// withSelfTestStage is a private denial-only gate. It does not create a journal
// operation or authorize publication. The caller must preserve the original
// admitted mutation, result and UNKNOWN semantics. Only the original
// MutationAdmitted native branch may call this gate; MutationExisting is never
// permission to invoke it. finish receives the final
// native result after descriptor close and profile recheck, and owns terminal
// persistence while the gate remains held. Only one attempt can use the
// pinned stage owner, and process admission cannot race its lifetime. Neither
// callback may synchronously close NativeRuntime or reenter this owner.
func (s *SettingsMutationIngress) withSelfTestStage(ctx context.Context, operation string, use func(context.Context, int, NativeRoot) error, finish func(error) error) error {
	if s == nil || ctx == nil || ctx.Err() != nil || !mutation.ScratchLeaf(mutation.ScratchPath(operation)) || use == nil || finish == nil {
		return computerUnavailable()
	}
	s.mu.Lock()
	if !s.stageBaseline || s.stageOwner == nil || s.stageLifetime == nil || s.stageLifetime.Err() != nil || s.operations == nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.retirementErr != nil || s.recoveryReserved || ctx.Err() != nil {
		s.mu.Unlock()
		return computerUnavailable()
	}
	own := s.operations[operation]
	if own == nil || !own.stageScratch || own.stageAttempted || !own.pending || own.settled || own.process != nil || own.path != mutation.ScratchPath(operation) {
		s.mu.Unlock()
		return computerUnavailable()
	}
	for key, record := range s.operations {
		if key == operation {
			continue
		}
		if record == nil || ((record.process != nil || record.stageScratch) && (record.pending || !record.settled)) {
			s.mu.Unlock()
			return computerUnavailable()
		}
	}
	own.stageAttempted = true
	s.stagePending = true
	done := make(chan struct{})
	s.stageDone = done
	owner, lifetime := s.stageOwner, s.stageLifetime
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.stagePending = false
		s.stageDone = nil
		close(done)
		s.mu.Unlock()
	}()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(lifetime, cancel)
	defer stop()
	defer cancel()
	return finish(owner.run(bounded, use))
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

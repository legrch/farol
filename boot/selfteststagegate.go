package boot

import "context"

// withSelfTestStage is a private denial-only gate. It does not create a journal
// operation or authorize publication. The caller must preserve the original
// admitted mutation, result and UNKNOWN semantics. finish receives the final
// native result after descriptor close and profile recheck, and owns terminal
// persistence while the gate remains held. Only one attempt can use the
// pinned stage owner, and process admission cannot race its lifetime. Neither
// callback may synchronously close NativeRuntime or reenter this owner.
func (s *SettingsMutationIngress) withSelfTestStage(ctx context.Context, use func(context.Context, int, NativeRoot) error, finish func(error) error) error {
	if s == nil || ctx == nil || ctx.Err() != nil || use == nil || finish == nil {
		return computerUnavailable()
	}
	s.mu.Lock()
	if !s.stageBaseline || s.stageOwner == nil || s.stageLifetime == nil || s.stageLifetime.Err() != nil || s.operations == nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.retirementErr != nil || s.recoveryReserved || ctx.Err() != nil {
		s.mu.Unlock()
		return computerUnavailable()
	}
	for _, record := range s.operations {
		if record == nil || (record.process != nil && (record.pending || !record.settled)) {
			s.mu.Unlock()
			return computerUnavailable()
		}
	}
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

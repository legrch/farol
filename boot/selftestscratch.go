package boot

import (
	"context"
	"strconv"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// createSelfTestScratch accepts only an existing approved workspace and an
// owner-selected operation ID. It never accepts a path or renews authority.
// The private ledger and original journal own one attempt and its observation.
func (s *SettingsMutationIngress) createSelfTestScratch(ctx context.Context, operation, workspace string, publication wire.ComputerAuthorityPublication) (*mutationsvc.OwnerResponse, error) {
	return s.createSelfTestScratchForRun(ctx, nil, operation, workspace, publication)
}

func (s *SettingsMutationIngress) createSelfTestScratchForRun(ctx context.Context, run *selfTestRunLease, operation, workspace string, publication wire.ComputerAuthorityPublication) (*mutationsvc.OwnerResponse, error) {
	leaf := state.ScratchPath(operation)
	if s == nil || s.computer == nil || ctx == nil || ctx.Err() != nil || !state.ScratchLeaf(leaf) || !state.Identifier(workspace, 120) {
		return nil, mutationInvalid()
	}
	generation, err := strconv.ParseUint(publication.Generation, 10, 64)
	if err != nil || generation > state.MaxSafeInteger || strconv.FormatUint(generation, 10) != publication.Generation {
		return nil, mutationInvalid()
	}
	native, ok := s.dependencies.native.(stagedScratchNative)
	if !ok || native == nil {
		return nil, computerUnavailable()
	}
	if run == nil {
		s.mu.Lock()
		if !s.stageBaseline || s.stageOwner == nil || s.stageLifetime == nil || s.stageLifetime.Err() != nil || s.selfTestRun != nil || s.scratchPreflight != nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
		done := make(chan struct{})
		s.scratchPreflight = done
		lifetime := s.stageLifetime
		s.mu.Unlock()
		bounded, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(lifetime, cancel)
		ctx = bounded
		defer func() {
			stop()
			cancel()
			s.mu.Lock()
			s.scratchPreflight = nil
			close(done)
			s.mu.Unlock()
		}()
	} else {
		s.mu.Lock()
		if s.selfTestRun != run || run.ledger != s || run.operation != operation || run.workspace != workspace || run.active || run.ctx.Err() != nil || s.stageClosed || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
		run.active = true
		run.callDone = make(chan struct{})
		done := run.callDone
		s.mu.Unlock()
		bounded, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(run.ctx, cancel)
		ctx = bounded
		defer func() {
			stop()
			cancel()
			s.mu.Lock()
			run.active = false
			close(done)
			if run.ctx.Err() != nil {
				run.abandonUnstartedLocked()
			}
			s.mu.Unlock()
		}()
	}
	s.mu.Lock()
	reserved := s.recoveryReserved || (run == nil && s.selfTestRun != nil)
	s.mu.Unlock()
	if reserved {
		return nil, computerUnavailable()
	}
	if err := s.computer.refreshCurrentApproval(ctx); err != nil {
		return nil, err
	}
	current, err := s.computer.settingsAuthority(ctx, publication)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if !s.stageBaseline || s.stageOwner == nil || s.stageLifetime == nil || s.stageLifetime.Err() != nil || s.stageClosed || s.stagePending || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil || s.operations == nil || s.operations[operation] != nil || len(s.operations) >= 4096 || s.selfTestRun != run || (run != nil && (run.ledger != s || run.operation != operation || run.workspace != workspace || run.ctx.Err() != nil)) {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	for _, previous := range s.operations {
		if !stagingPriorEligible(previous) {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
	}
	record := &settingsMutationOperation{workspace: workspace, path: leaf, generation: generation, pending: true, stageScratch: true, selfTestRun: run, scratchDone: make(chan struct{})}
	s.operations[operation] = record
	s.mu.Unlock()
	finish := func(service *mutationsvc.OwnerService, err error, settled, created bool) {
		s.mu.Lock()
		record.scratch, record.failure, record.pending, record.settled = service, err, false, settled
		record.scratchCreated = created
		close(record.scratchDone)
		s.mu.Unlock()
	}
	if err = s.computer.claim(operation); err != nil {
		finish(nil, err, true, false)
		return nil, err
	}
	var clock computerport.Clock = s.computer.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	stage := &stagedScratchWorkspace{ledger: s, operation: operation, native: native, hold: run != nil}
	service, err := mutationsvc.NewForOwnerExecution(ctx, s.selection(operation, generation), current, s.dependencies.repository, stage, s.dependencies.digester, &sync.Mutex{}, clock)
	if err != nil {
		finish(nil, err, true, false)
		return nil, err
	}
	result, err := service.CreateScratch(ctx, workspace)
	settled := err == nil && result != nil && result.Publication == "durable" && (result.Phase == "completed" || result.Phase == "failed")
	if run != nil && settled && result.Phase == "completed" {
		if stage.custody == nil || result.Receipt == nil {
			settled = false
			err = computerUnavailable()
		} else {
			s.mu.Lock()
			run.scratchCustody, run.scratchIdentity = stage.custody, result.Receipt.Directory
			s.mu.Unlock()
			stage.custody = nil
		}
	}
	if stage.custody != nil {
		if closeErr := stage.custody.Close(); closeErr != nil {
			settled = false
			err = computerUnavailable()
		}
	}
	finish(service, err, settled, settled && result.Phase == "completed")
	return result, err
}

// observeSelfTestScratch reads the original owner identity only. It does not
// allocate a new lease, alter the historical record or dispatch another effect.
func (s *SettingsMutationIngress) observeSelfTestScratch(ctx context.Context, operation, workspace string, generation uint64) (*mutationsvc.OwnerResponse, error) {
	if s == nil || s.computer == nil || ctx == nil || ctx.Err() != nil || !state.ScratchLeaf(state.ScratchPath(operation)) || !state.Identifier(workspace, 120) || generation > state.MaxSafeInteger {
		return nil, mutationInvalid()
	}
	s.mu.Lock()
	record := s.operations[operation]
	var service *mutationsvc.OwnerService
	var failure error
	if record != nil {
		if !record.stageScratch || record.workspace != workspace || record.path != state.ScratchPath(operation) || record.generation != generation {
			s.mu.Unlock()
			return nil, mutationInvalid()
		}
		if record.pending {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
		service, failure = record.scratch, record.failure
	}
	s.mu.Unlock()
	request := mutationsvc.OwnerObservation{WorkspaceID: workspace, RelativePath: state.ScratchPath(operation)}
	if service != nil {
		out, err := service.Observe(ctx, request)
		return checkedScratchObservation(operation, out, err)
	}
	if record != nil {
		if failure != nil {
			return nil, failure
		}
		return nil, computerUnavailable()
	}
	observer, err := mutationsvc.NewOwnerObserver(s.selection(operation, generation), s.dependencies.repository)
	if err != nil {
		return nil, err
	}
	out, err := observer.Observe(ctx, request)
	return checkedScratchObservation(operation, out, err)
}

func checkedScratchObservation(operation string, out *mutationsvc.OwnerResponse, err error) (*mutationsvc.OwnerResponse, error) {
	if err != nil {
		return nil, err
	}
	if out == nil || !out.Scratch.Valid() || out.Scratch.RunID != operation || out.Scratch.Leaf != state.ScratchPath(operation) {
		return nil, mutationInvalid()
	}
	return out, nil
}

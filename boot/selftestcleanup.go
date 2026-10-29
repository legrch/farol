package boot

import (
	"context"
	"errors"
	"strconv"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// runScratchCleanup keeps the original profile owner alive through native
// removal and fd close. Once the callback starts, any lost outer result is
// unknown: the filesystem effect may have occurred.
type runScratchCleanup struct {
	owner  *computerStageOwner
	native port.ScratchCleanupWorkspace
}

func (w *runScratchCleanup) RemoveEmptyScratch(ctx context.Context, request port.ScratchCleanupRequest) error {
	if w == nil || w.owner == nil || w.native == nil {
		return authority.Fail("WORKSPACE_PATH_REFUSED", "native-workspace")
	}
	entered := false
	var callbackErr error
	err := w.owner.run(ctx, func(ctx context.Context, _ int, _ NativeRoot) error {
		entered = true
		callbackErr = w.native.RemoveEmptyScratch(ctx, request)
		return callbackErr
	})
	if entered && err != nil {
		if callbackErr != nil && onlyCleanupCallbackError(err, callbackErr) {
			return callbackErr
		}
		return authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
	}
	return err
}

// A profile check or descriptor close error joined to the native result can
// make an otherwise known native refusal uncertain. Preserve a refusal only
// when the outer owner returned that error alone.
func onlyCleanupCallbackError(err, callback error) bool {
	target, ok := onlyCleanupErrorLeaf(callback)
	if !ok {
		return false
	}
	actual, ok := onlyCleanupErrorLeaf(err)
	return ok && errors.Is(actual, target)
}

func onlyCleanupErrorLeaf(err error) (error, bool) {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		parts := joined.Unwrap()
		if len(parts) != 1 {
			return nil, false
		}
		return onlyCleanupErrorLeaf(parts[0])
	}
	if inner := errors.Unwrap(err); inner != nil {
		return onlyCleanupErrorLeaf(inner)
	}
	return err, err != nil
}

// cleanupSelfTestScratchForRun is the sole composition entry for a cleanup.
// The run owns the exclusion gate before creation and until cleanup has a
// durable completed terminal. A refusal, cancellation or unknown retains the
// original fixture and run fence; neither action may be replayed here.
func (s *SettingsMutationIngress) cleanupSelfTestScratchForRun(ctx context.Context, run *selfTestRunLease, publication wire.ComputerAuthorityPublication) (*mutationsvc.ScratchCleanupResponse, error) {
	if s == nil || s.computer == nil || run == nil || ctx == nil || ctx.Err() != nil {
		return nil, computerUnavailable()
	}
	generation, err := strconv.ParseUint(publication.Generation, 10, 64)
	if err != nil || generation > state.MaxSafeInteger || strconv.FormatUint(generation, 10) != publication.Generation {
		return nil, mutationInvalid()
	}
	native, ok := s.dependencies.native.(port.ScratchCleanupWorkspace)
	if !ok || native == nil {
		return nil, computerUnavailable()
	}
	s.mu.Lock()
	record := s.operations[run.operation]
	if s.selfTestRun != run || run.ledger != s || run.active || run.cleanupStarted || run.ctx.Err() != nil || s.stageClosed || s.frozen || s.stagePending || s.processDraining || s.recoveryReserved || s.retirementErr != nil || s.stageOwner == nil || record == nil || !record.stageScratch || !record.scratchCreated || record.selfTestRun != run || record.pending || !record.settled || record.scratch == nil || record.workspace != run.workspace || record.generation != generation {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	for id, previous := range s.operations {
		if id != run.operation && !cleanupPriorEligible(previous, run) {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
	}
	// A nonempty fixture cannot use the empty-inventory journal. Refuse before
	// admitting a cleanup record until file custody and inventory are durable.
	if run.fixtureWriteStarted || run.fixtureFileIdentity.Valid() || run.fixtureFileHash != "" {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	run.cleanupStarted, run.active = true, true
	run.callDone = make(chan struct{})
	done, owner := run.callDone, s.stageOwner
	s.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(run.ctx, cancel)
	defer func() { stop(); cancel() }()
	var out *mutationsvc.ScratchCleanupResponse
	defer func() {
		s.mu.Lock()
		run.active = false
		close(done)
		if out != nil && out.Phase == string(state.Completed) && out.Publication == "durable" && s.selfTestRun == run && !s.stagePending {
			s.selfTestRun = nil
			close(run.released)
			run.stop()
			if run.autoStop != nil {
				run.autoStop()
			}
			run.cancel()
		}
		s.mu.Unlock()
	}()
	if err = s.computer.refreshCurrentApproval(bounded); err != nil {
		return nil, err
	}
	current, err := s.computer.settingsAuthority(bounded, publication)
	if err != nil {
		return nil, err
	}
	var clock port.Clock = s.computer.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	service, err := mutationsvc.NewForOwnerExecution(bounded, s.selection(run.operation, generation), current, s.dependencies.repository, s.dependencies.native, s.dependencies.digester, &sync.Mutex{}, clock)
	if err != nil {
		return nil, err
	}
	out, err = service.CleanupScratch(bounded, run.workspace, &runScratchCleanup{owner: owner, native: native})
	return out, err
}

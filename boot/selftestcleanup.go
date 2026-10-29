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
	owner          *computerStageOwner
	native         port.ScratchCleanupWorkspace
	custody        port.ScratchDirectoryCustody
	closed         bool
	closeAttempted bool
}

func (w *runScratchCleanup) RemoveEmptyScratch(ctx context.Context, request port.ScratchCleanupRequest) error {
	if w == nil || w.owner == nil || w.native == nil || w.custody == nil || request.WithPublication == nil {
		return authority.Fail("WORKSPACE_PATH_REFUSED", "native-workspace")
	}
	if err := w.custody.Check(request.Binding.Directory); err != nil {
		return err
	}
	guard := request.WithPublication
	request.WithPublication = func(ctx context.Context, publish func() error) error {
		return guard(ctx, func() error {
			if err := w.custody.Check(request.Binding.Directory); err != nil {
				return err
			}
			return publish()
		})
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
	if err == nil {
		// This close is part of the original attempt and must precede the
		// service's single terminal Save. Never report durable completion if
		// descriptor closure is not confirmed.
		w.closeAttempted = true
		if err := w.custody.Close(); err != nil {
			return authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
		}
		w.closed = true
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
	if s.selfTestRun != run || run.ledger != s || run.active || run.cleanupStarted || run.ctx.Err() != nil || s.stageClosed || s.frozen || s.stagePending || s.processDraining || s.recoveryReserved || s.retirementErr != nil || s.stageOwner == nil || run.scratchCustody == nil || !run.scratchIdentity.Valid() || record == nil || !record.stageScratch || !record.scratchCreated || record.selfTestRun != run || record.pending || !record.settled || record.scratch == nil || record.workspace != run.workspace || record.generation != generation {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	for id, previous := range s.operations {
		if id != run.operation && !cleanupPriorEligible(previous, run) {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
	}
	hasFile := run.fixtureFileIdentity.Valid() && run.fixtureFileHash != "" && run.fixtureOperation != "" && run.fixtureCustody != nil
	if (run.fixtureWriteStarted || run.fixtureFileIdentity.Valid() || run.fixtureFileHash != "") && !hasFile {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	run.cleanupStarted, run.active = true, true
	run.callDone = make(chan struct{})
	done, owner, custody, identity := run.callDone, s.stageOwner, run.scratchCustody, run.scratchIdentity
	fileCustody, fileIdentity, fileOperation, fileHash := run.fixtureCustody, run.fixtureFileIdentity, run.fixtureOperation, run.fixtureFileHash
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
	if err := custody.Check(identity); err != nil {
		return nil, err
	}
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
	if hasFile {
		fileNative, ok := s.dependencies.native.(port.ScratchFileCleanupWorkspace)
		if !ok || fileNative == nil {
			return nil, computerUnavailable()
		}
		creationID := state.Identity{Scope: state.ScopeOwnerSettings, OperationID: run.operation, OwnerID: s.computer.ownerID, ProfileID: s.computer.peer.ProfileId, ComputerID: s.computer.computerID}
		fileID := state.Identity{Scope: state.ScopeConnector, OperationID: fileOperation, OwnerID: s.computer.ownerID, ProfileID: s.computer.peer.ProfileId, ComputerID: s.computer.computerID}
		creation, e1 := s.dependencies.repository.Load(bounded, creationID)
		file, e2 := s.dependencies.repository.Load(bounded, fileID)
		if e1 != nil || e2 != nil {
			return nil, computerUnavailable()
		}
		inventory, e := state.NewScratchFileInventory(creation, file, fileIdentity)
		if e != nil || inventory == nil || inventory.Creation.Directory != identity || inventory.SHA256 != fileHash {
			return nil, computerUnavailable()
		}
		worker := &runScratchFileCleanup{owner: owner, native: fileNative, directory: custody, file: fileCustody}
		out, err = service.CleanupScratchFile(bounded, run.workspace, *inventory, custody, fileCustody, worker)
		if worker.closeAttempted {
			s.mu.Lock()
			run.scratchCustody, run.fixtureCustody = nil, nil
			s.mu.Unlock()
		}
		if err == nil && out != nil && out.Phase == string(state.Completed) && out.Publication == "durable" && !worker.closed {
			out = nil
			return nil, computerUnavailable()
		}
		return out, err
	}
	worker := &runScratchCleanup{owner: owner, native: native, custody: custody}
	out, err = service.CleanupScratch(bounded, run.workspace, worker)
	if worker.closeAttempted {
		// Close belongs to the original attempt even when its result is
		// unknown. Never close that same descriptor a second time at shutdown.
		s.mu.Lock()
		run.scratchCustody = nil
		s.mu.Unlock()
	}
	if err == nil && out != nil && out.Phase == string(state.Completed) && out.Publication == "durable" {
		if !worker.closed {
			out = nil
			return nil, computerUnavailable()
		}
	}
	return out, err
}

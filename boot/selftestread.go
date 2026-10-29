package boot

import (
	"context"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// The adapter is private to one admitted read; it cannot be selected by a
// renderer or used to read a different file through the retained descriptors.
type selfTestReadWorkspace struct {
	native    port.ScratchBoundWorkspace
	workspace string
	binding   port.ScratchReadBinding
}

func (w *selfTestReadWorkspace) Read(ctx context.Context, request port.ReadRequest) (*port.ReadResponse, error) {
	if w == nil || w.native == nil || request.Workspace.WorkspaceID != w.workspace || request.RelativePath != state.ScratchPath(w.binding.RunID)+"/check.txt" || request.Range != nil {
		return nil, computerUnavailable()
	}
	return w.native.ReadScratch(ctx, request, w.binding)
}

func (*selfTestReadWorkspace) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	return nil, computerUnavailable()
}

// readFixture borrows custody only while the run fence is held. Ordinary Read
// admission and final disclosure remain with the selected connector lease.
func (r *selfTestRunLease) readFixture(ctx context.Context, connector *computerConnector, slot *connectorSlot, call string) (*workspacect.ReadResponse, error) {
	if r == nil || r.ledger == nil || ctx == nil || ctx.Err() != nil || connector == nil || connector.mutations != r.ledger || slot == nil || slot.route == nil || !validIngressID(call) {
		return nil, computerUnavailable()
	}
	native, ok := slot.route.workspace.(port.ScratchBoundWorkspace)
	if !ok || native == nil {
		return nil, computerUnavailable()
	}
	s := r.ledger
	s.mu.Lock()
	original := s.operations[r.operation]
	if s.selfTestRun != r || r.active || r.cleanupStarted || r.ctx.Err() != nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil || original == nil || !original.stageScratch || !original.scratchCreated || original.selfTestRun != r || original.pending || !original.settled || original.workspace != r.workspace || r.scratchCustody == nil || !r.scratchIdentity.Valid() || r.fixtureCustody == nil || !r.fixtureFileIdentity.Valid() || r.fixtureFileHash != selfTestFileHash(selfTestFileAfter) || !r.fixtureEditStarted || !validIngressID(r.fixtureOperation) {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	r.active, r.callDone = true, make(chan struct{})
	done := r.callDone
	binding := port.ScratchReadBinding{RunID: r.operation, Directory: r.scratchIdentity, File: r.fixtureFileIdentity, DirectoryHold: r.scratchCustody, FileHold: r.fixtureCustody}
	s.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.ctx, cancel)
	defer func() {
		stop()
		cancel()
		s.mu.Lock()
		r.active = false
		close(done)
		s.mu.Unlock()
	}()
	if err := connector.checkMutationSlot(bounded, slot, slot.opened.Execution); err != nil {
		return nil, err
	}
	e := slot.opened.Execution
	epoch, err := strconv.ParseUint(e.TaskEpoch, 10, 64)
	if err != nil || strconv.FormatUint(epoch, 10) != e.TaskEpoch {
		return nil, computerUnavailable()
	}
	generation, err := strconv.ParseUint(e.Generation, 10, 64)
	if err != nil || strconv.FormatUint(generation, 10) != e.Generation {
		return nil, computerUnavailable()
	}
	route := *slot.route
	route.workspace = &selfTestReadWorkspace{native: native, workspace: r.workspace, binding: binding}
	contract, err := route.selectContract(bounded, operationBinding(e.OwnerId, e.SessionId, e.TaskId, epoch, e.ParticipantId, e.TurnId), authority.Read)
	if err != nil {
		return nil, err
	}
	return contract.Read(bounded, workspacect.ReadRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch, ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: call, WorkspaceID: r.workspace, RelativePath: state.ScratchPath(r.operation) + "/check.txt"})
}

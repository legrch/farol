package boot

import (
	"context"
	"errors"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type selfTestSearchListWorkspace struct {
	list      port.ScratchBoundList
	search    port.ScratchBoundSearch
	workspace string
	binding   port.ScratchReadBinding
}

func (*selfTestSearchListWorkspace) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	return nil, computerUnavailable()
}
func (w *selfTestSearchListWorkspace) List(ctx context.Context, request port.ListRequest) (*port.ListResponse, error) {
	if w.list == nil || request.Workspace.WorkspaceID != w.workspace || request.RelativePath != state.ScratchPath(w.binding.RunID) {
		return nil, computerUnavailable()
	}
	return w.list.ListScratch(ctx, request, w.binding)
}
func (w *selfTestSearchListWorkspace) Search(ctx context.Context, request port.SearchRequest) (*port.SearchResponse, error) {
	if w.search == nil || request.Workspace.WorkspaceID != w.workspace || request.RelativePath != state.ScratchPath(w.binding.RunID)+"/check.txt" {
		return nil, computerUnavailable()
	}
	return w.search.SearchScratch(ctx, request, w.binding)
}

func selfTestReadFailure(name, operation string, err error) selfTestStep {
	step := selfTestStep{Name: name, Operation: operation, Status: "unknown"}
	var failure *workspacect.Failure
	if errors.As(err, &failure) && failure != nil && failure.Retry == "never" {
		switch failure.Code {
		case "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_NOT_FOUND", "WORKSPACE_NOT_A_FILE", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_NOT_TEXT":
			step.Status, step.Code = "fail", failure.Code
		}
	}
	return step
}

// workspaceCheck performs one ordinary connector call and retains only its
// content-free outcome. Bootstrap instruction text and search matches are not
// stored or exposed. The read step uses the pinned scratch adapter.
func (p *connectorSelfTestPlan) workspaceCheck(ctx context.Context, name, call string) selfTestStep {
	step := selfTestStep{Name: name, Operation: call, Status: "unknown"}
	if p == nil || p.run == nil || p.connector == nil || p.slot == nil || p.slot.route == nil || ctx == nil || ctx.Err() != nil || !validIngressID(call) {
		return step
	}
	if name == "read" {
		out, err := p.run.readFixture(ctx, p.connector, p.slot, call)
		if err != nil {
			return selfTestReadFailure(name, call, err)
		}
		if out != nil && out.Text == selfTestFileAfter && out.Bytes == uint64(len(selfTestFileAfter)) && out.SHA256 == selfTestFileHash(selfTestFileAfter) && out.Page == nil {
			step.Status = "pass"
		} else {
			step.Status, step.Code = "fail", "SELF_TEST_RESULT_MISMATCH"
		}
		return step
	}
	// Retain original custody and cancel with the run on Quit. No ledger lock is
	// held while native or authority owners run.
	run := p.run
	if run.ledger == nil || run.ledger != p.connector.mutations || run.operation != p.ids.run || run.workspace != p.workspace {
		return step
	}
	ledger := run.ledger
	ledger.mu.Lock()
	original := ledger.operations[run.operation]
	if ledger.selfTestRun != run || run.active || run.cleanupStarted || run.ctx.Err() != nil || ledger.stagePending || ledger.stageClosed || ledger.frozen || ledger.processDraining || ledger.recoveryReserved || ledger.retirementErr != nil || original == nil || !original.stageScratch || !original.scratchCreated || original.selfTestRun != run || original.pending || !original.settled || original.workspace != run.workspace || run.scratchCustody == nil || !run.scratchIdentity.Valid() || run.fixtureCustody == nil || !run.fixtureFileIdentity.Valid() || run.fixtureFileHash != selfTestFileHash(selfTestFileAfter) || !run.fixtureEditStarted || !validIngressID(run.fixtureOperation) {
		ledger.mu.Unlock()
		return step
	}
	run.active, run.callDone = true, make(chan struct{})
	done := run.callDone
	fixture := port.ScratchReadBinding{RunID: run.operation, Directory: run.scratchIdentity, File: run.fixtureFileIdentity, DirectoryHold: run.scratchCustody, FileHold: run.fixtureCustody}
	ledger.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(run.ctx, cancel)
	defer func() {
		stop()
		cancel()
		ledger.mu.Lock()
		run.active = false
		close(done)
		ledger.mu.Unlock()
	}()
	ctx = bounded
	if err := p.connector.checkMutationSlot(ctx, p.slot, p.slot.opened.Execution); err != nil {
		return selfTestReadFailure(name, call, err)
	}
	e := p.slot.opened.Execution
	epoch, err := strconv.ParseUint(e.TaskEpoch, 10, 64)
	if err != nil || strconv.FormatUint(epoch, 10) != e.TaskEpoch {
		return step
	}
	generation, err := strconv.ParseUint(e.Generation, 10, 64)
	if err != nil || strconv.FormatUint(generation, 10) != e.Generation {
		return step
	}
	binding := operationBinding(e.OwnerId, e.SessionId, e.TaskId, epoch, e.ParticipantId, e.TurnId)
	route := *p.slot.route
	if name == "list" || name == "search" {
		list, _ := route.workspace.(port.ScratchBoundList)
		search, _ := route.workspace.(port.ScratchBoundSearch)
		if name == "list" && list == nil || name == "search" && search == nil {
			return step
		}
		route.workspace = &selfTestSearchListWorkspace{list: list, search: search, workspace: p.workspace, binding: fixture}
	}
	var contract *workspacect.Contract
	if name == "catalogue" {
		contract, err = route.selectCatalogueContract(ctx, binding)
	} else {
		capability := authority.Read
		if name == "list" {
			capability = authority.List
		}
		if name == "search" {
			capability = authority.Search
		}
		if name != "bootstrap" && name != "list" && name != "search" {
			return step
		}
		contract, err = route.selectContract(ctx, binding, capability)
	}
	if err != nil {
		return selfTestReadFailure(name, call, err)
	}
	leaf := state.ScratchPath(p.ids.run)
	match := false
	switch name {
	case "catalogue":
		var out *workspacect.CatalogueResponse
		out, err = contract.Catalogue(ctx, workspacect.CatalogueRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch, ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: call})
		if out != nil {
			for _, entry := range out.Workspaces {
				if entry.WorkspaceID == p.workspace {
					match = true
				}
			}
		}
	case "bootstrap":
		var out *workspacect.BootstrapResponse
		out, err = contract.Bootstrap(ctx, workspacect.BootstrapRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch, ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: call, WorkspaceID: p.workspace, RelativeDirectory: "."})
		match = out != nil && out.Complete && out.WorkspaceID == p.workspace && out.RelativeDirectory == "."
	case "list":
		var out *workspacect.ListResponse
		out, err = contract.List(ctx, workspacect.ListRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch, ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: call, WorkspaceID: p.workspace, RelativePath: leaf})
		if err == nil && out != nil && out.Truncated {
			step.Code = "SELF_TEST_SCAN_LIMITED"
			return step
		}
		match = out != nil && !out.Truncated && len(out.Entries) == 1 && out.Entries[0] == "check.txt"
	case "search":
		var out *workspacect.SearchResponse
		// This is an explicit-file search. It does not prove recursive traversal
		// or ignore-rule behavior.
		out, err = contract.Search(ctx, workspacect.SearchRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch, ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: call, WorkspaceID: p.workspace, RelativePath: leaf + "/check.txt", Pattern: "Farol self-test verified"})
		if err == nil && out != nil && (out.ResultLimited || out.ScanLimited) {
			step.Code = "SELF_TEST_SCAN_LIMITED"
			return step
		}
		match = out != nil && !out.ResultLimited && !out.ScanLimited && len(out.Matches) == 1 && out.Matches[0].Path == leaf+"/check.txt" && out.Matches[0].Line == 1 && out.Matches[0].Text == "Farol self-test verified" && !out.Matches[0].Truncated
	}
	if err != nil {
		return selfTestReadFailure(name, call, err)
	}
	if match {
		step.Status = "pass"
	} else {
		step.Status, step.Code = "fail", "SELF_TEST_RESULT_MISMATCH"
	}
	return step
}

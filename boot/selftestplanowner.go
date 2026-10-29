package boot

import (
	"context"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// All IDs are allocated by the caller before the first effect; this owner has
// no transport or renderer entry point and grants no execution authority.
type selfTestIDs struct {
	run, write, writeCall, edit, editCall, quick, quickCall, quickCancel, cancel, cancelCall, cancelOperation string
	catalogue, bootstrap, list, read, search                                                                  string
}

// Versioned, bounded derivation ties each child to the original durable
// scratch identity. This is correlation only, never an admission decision.
func selfTestIDsV1(run string) (selfTestIDs, bool) {
	ids := selfTestIDs{run: run, write: run + "-st1-write", writeCall: run + "-st1-write-call", edit: run + "-st1-edit", editCall: run + "-st1-edit-call", quick: run + "-st1-quick", quickCall: run + "-st1-quick-call", quickCancel: run + "-st1-quick-unused-cancel", cancel: run + "-st1-cancel", cancelCall: run + "-st1-cancel-call", cancelOperation: run + "-st1-cancel-op"}
	return ids, ids.valid()
}

func selfTestIDsV2(run string) (selfTestIDs, bool) {
	ids := selfTestIDs{run: run, write: run + "-st2-write", writeCall: run + "-st2-write-call", edit: run + "-st2-edit", editCall: run + "-st2-edit-call", quick: run + "-st2-quick", quickCall: run + "-st2-quick-call", quickCancel: run + "-st2-quick-unused-cancel", cancel: run + "-st2-cancel", cancelCall: run + "-st2-cancel-call", cancelOperation: run + "-st2-cancel-op", catalogue: run + "-st2-catalogue", bootstrap: run + "-st2-bootstrap", list: run + "-st2-list", read: run + "-st2-read", search: run + "-st2-search"}
	return ids, ids.valid()
}

func (ids selfTestIDs) valid() bool {
	if !state.ScratchLeaf(state.ScratchPath(ids.run)) {
		return false
	}
	seen := map[string]bool{}
	for _, id := range []string{ids.run, ids.write, ids.writeCall, ids.edit, ids.editCall, ids.quick, ids.quickCall, ids.quickCancel, ids.cancel, ids.cancelCall, ids.cancelOperation} {
		if !validIngressID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	reads := []string{ids.catalogue, ids.bootstrap, ids.list, ids.read, ids.search}
	if reads[0] != "" || reads[1] != "" || reads[2] != "" || reads[3] != "" || reads[4] != "" {
		for _, id := range reads {
			if !validIngressID(id) || seen[id] {
				return false
			}
			seen[id] = true
		}
	}
	return true
}

type connectorSelfTestPlan struct {
	connector   *computerConnector
	slot        *connectorSlot
	workspace   string
	publication wire.ComputerAuthorityPublication
	ids         selfTestIDs
	run         *selfTestRunLease
}

func selfTestFailure(name, operation string, err error) selfTestStep {
	step := selfTestStep{Name: name, Status: "unknown", Operation: operation}
	var unsettled *connectorMutationUnsettled
	if errors.As(err, &unsettled) {
		return step
	}
	var f *mutationct.Failure
	if errors.As(err, &f) && f != nil {
		step.Code = f.Code
		if f.Retry == "never" && f.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
			step.Status = "fail"
		}
	}
	return step
}

func (p *connectorSelfTestPlan) create(ctx context.Context) selfTestStep {
	step := selfTestStep{Name: "scratch", Status: "unknown", Operation: p.ids.run}
	expectedIDs, validIDs := selfTestIDsV1(p.ids.run)
	if p.connector == nil || p.connector.mutations == nil || p.slot == nil || p.slot.guard == nil || p.slot.guard.publication != p.publication || !validIDs || p.ids != expectedIDs || !state.Identifier(p.workspace, 120) {
		return step
	}
	if err := p.connector.checkMutationSlot(ctx, p.slot, p.slot.opened.Execution); err != nil {
		return selfTestFailure(step.Name, step.Operation, err)
	}
	run, err := p.connector.mutations.beginSelfTestRun(ctx, p.ids.run, p.workspace)
	if err != nil {
		return selfTestFailure(step.Name, step.Operation, err)
	}
	p.run = run
	out, err := p.connector.mutations.createSelfTestScratchForRun(ctx, run, p.ids.run, p.workspace, p.publication)
	if err != nil {
		_ = run.abandonUnstarted()
		return selfTestFailure(step.Name, step.Operation, err)
	}
	if out != nil && out.Phase == "completed" && out.Publication == "durable" && out.Receipt != nil {
		step.Status = "pass"
	} else if out != nil && out.Phase == "failed" && out.Publication == "durable" {
		step.Status = "fail"
		if out.Failure != nil {
			step.Code = out.Failure.Code
		}
	}
	return step
}

func (p *connectorSelfTestPlan) mutation(ctx context.Context, name, operation, call string, edit bool) selfTestStep {
	step := selfTestStep{Name: name, Status: "unknown", Operation: operation}
	if p.run == nil {
		return step
	}
	out, err := p.run.mutateFixture(ctx, p.connector, p.slot, operation, call, edit)
	if err != nil {
		return selfTestFailure(name, operation, err)
	}
	if out != nil && out.Publication == "durable" && out.Phase == "completed" {
		step.Status = "pass"
	} else if out != nil && out.Publication == "durable" && out.Phase == "failed" {
		step.Status = "fail"
		if out.Failure != nil {
			step.Code = out.Failure.Code
		}
	}
	return step
}
func (p *connectorSelfTestPlan) write(ctx context.Context) selfTestStep {
	return p.mutation(ctx, "write", p.ids.write, p.ids.writeCall, false)
}
func (p *connectorSelfTestPlan) edit(ctx context.Context) selfTestStep {
	return p.mutation(ctx, "edit", p.ids.edit, p.ids.editCall, true)
}

func (p *connectorSelfTestPlan) observe(ctx context.Context) selfTestStep {
	step := selfTestStep{Name: "mutation read", Status: "unknown", Operation: p.ids.edit}
	if p.run == nil {
		return step
	}
	out, err := p.connector.observeMutation(ctx, p.slot, p.ids.edit, mutationct.ConnectorObservation{WorkspaceID: p.workspace, RelativePath: state.ScratchPath(p.ids.run) + "/check.txt"})
	if err != nil {
		return selfTestFailure(step.Name, step.Operation, err)
	}
	if out != nil && out.OperationID == p.ids.edit && out.Phase == "completed" && out.Publication == "durable" && out.Receipt != nil && out.Receipt.AfterSHA256 == selfTestFileHash(selfTestFileAfter) {
		step.Status = "pass"
	}
	return step
}

func (p *connectorSelfTestPlan) cleanup(ctx context.Context) selfTestStep {
	step := selfTestStep{Name: "cleanup", Status: "unknown", Operation: p.ids.run}
	if p.run == nil {
		return step
	}
	out, err := p.connector.mutations.cleanupSelfTestScratchForRun(ctx, p.run, p.publication)
	if err != nil {
		return selfTestFailure(step.Name, step.Operation, err)
	}
	if out != nil && out.Phase == "completed" && out.Publication == "durable" {
		step.Status = "pass"
	} else if out != nil && out.Phase == "failed" && out.Publication == "durable" {
		step.Status = "fail"
		if out.Failure != nil {
			step.Code = out.Failure.Code
		}
	}
	return step
}

func (p *connectorSelfTestPlan) shell(ctx context.Context, kind selfTestShellKind) selfTestStep {
	name, operation, call, cancel := "shell", p.ids.quick, p.ids.quickCall, p.ids.quickCancel
	if kind == selfTestShellCancel {
		name, operation, call, cancel = "shell cancel", p.ids.cancel, p.ids.cancelCall, p.ids.cancelOperation
	}
	step := selfTestStep{Name: name, Status: "unknown", Operation: operation}
	check, err := newSelfTestShell(p.connector, p.slot, p.workspace, operation, call, cancel, kind)
	if err != nil {
		return step
	}
	result := check.check(ctx)
	step.Status, step.Code, step.Handle, step.CancelOperation, step.DescendantCleanup = result.Status, result.Code, result.Handle, result.CancelOperation, string(result.DescendantCleanup)
	if result.Handle == "" {
		return step
	}
	ledger := p.connector.mutations
	ledger.mu.Lock()
	record := ledger.operations[operation]
	var done <-chan struct{}
	if record != nil && record.process != nil {
		done = record.process.collectionDone
	}
	ledger.mu.Unlock()
	if done == nil {
		step.Status = "unknown"
		return step
	}
	select {
	case <-ctx.Done():
		step.Status = "unknown"
		return step
	case <-done:
	}
	ledger.mu.Lock()
	settled := record != nil && record.process != nil && !record.pending && record.settled && record.process.collectionErr == nil && !record.process.cancelUnknown && record.process.publication != ""
	ledger.mu.Unlock()
	if !settled {
		step.Status = "unknown"
	}
	return step
}

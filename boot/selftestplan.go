package boot

import (
	"context"
	"sync"
)

// selfTestStep is a bounded observation of one original attempt. A step may
// report failure or unknown, but never creates a replacement attempt.
type selfTestStep struct {
	Name, Status, Code, Operation              string
	Handle, CancelOperation, DescendantCleanup string
}

type selfTestReport struct {
	Status string
	Steps  []selfTestStep
}

type selfTestPlanOwner interface {
	create(context.Context) selfTestStep
	write(context.Context) selfTestStep
	edit(context.Context) selfTestStep
	observe(context.Context) selfTestStep
	cleanup(context.Context) selfTestStep
	shell(context.Context, selfTestShellKind) selfTestStep
}

// A caller retains this one owner for the lifetime of its original request.
// A repeated observation cannot start a second plan or repeat an effect.
type selfTestExecution struct {
	mu                sync.Mutex
	owner             selfTestPlanOwner
	version           uint8
	started, finished bool
	result            selfTestReport
}

func (e *selfTestExecution) execute(ctx context.Context) selfTestReport {
	if e == nil {
		return selfTestReport{Status: "unknown"}
	}
	e.mu.Lock()
	if e.started {
		out := selfTestReport{Status: "unknown"}
		if e.finished {
			out = copySelfTestReport(e.result)
		}
		e.mu.Unlock()
		return out
	}
	e.started = true
	e.mu.Unlock()
	var out selfTestReport
	if e.version == 4 {
		out = runSelfTestPlanV4(ctx, e.owner)
	} else if e.version == 3 {
		out = runSelfTestPlanV3(ctx, e.owner)
	} else if e.version == 2 {
		out = runSelfTestPlanV2(ctx, e.owner)
	} else {
		out = runSelfTestPlan(ctx, e.owner)
	}
	e.mu.Lock()
	e.result, e.finished = copySelfTestReport(out), true
	e.mu.Unlock()
	return copySelfTestReport(out)
}

type selfTestWorkspaceOwner interface {
	workspaceCheck(context.Context, string, string) selfTestStep
	workspaceIDs() selfTestIDs
}

func runSelfTestPlanV2(ctx context.Context, owner selfTestPlanOwner) selfTestReport {
	return runSelfTestReadPlan(ctx, owner, false, false)
}

func runSelfTestPlanV3(ctx context.Context, owner selfTestPlanOwner) selfTestReport {
	return runSelfTestReadPlan(ctx, owner, true, false)
}

func runSelfTestPlanV4(ctx context.Context, owner selfTestPlanOwner) selfTestReport {
	return runSelfTestReadPlan(ctx, owner, true, true)
}

func runSelfTestReadPlan(ctx context.Context, owner selfTestPlanOwner, directory, git bool) selfTestReport {
	report := selfTestReport{Status: "unknown"}
	read, ok := owner.(selfTestWorkspaceOwner)
	if ctx == nil || ctx.Err() != nil || owner == nil || !ok {
		return report
	}
	ids := read.workspaceIDs()
	steps := []func(context.Context) selfTestStep{
		owner.create, owner.write, owner.edit, owner.observe,
		func(ctx context.Context) selfTestStep { return read.workspaceCheck(ctx, "catalogue", ids.catalogue) },
		func(ctx context.Context) selfTestStep { return read.workspaceCheck(ctx, "bootstrap", ids.bootstrap) },
		func(ctx context.Context) selfTestStep { return read.workspaceCheck(ctx, "list", ids.list) },
		func(ctx context.Context) selfTestStep { return read.workspaceCheck(ctx, "read", ids.read) },
		func(ctx context.Context) selfTestStep { return read.workspaceCheck(ctx, "search", ids.search) },
	}
	checks := []selfTestStep{{Name: "catalogue", Operation: ids.catalogue}, {Name: "bootstrap", Operation: ids.bootstrap}, {Name: "list", Operation: ids.list}, {Name: "read", Operation: ids.read}, {Name: "search", Operation: ids.search}}
	if directory {
		steps = append(steps, func(ctx context.Context) selfTestStep {
			return read.workspaceCheck(ctx, "directory search", ids.directorySearch)
		})
		checks = append(checks, selfTestStep{Name: "directory search", Operation: ids.directorySearch})
	}
	steps = append(steps,
		owner.cleanup,
		func(ctx context.Context) selfTestStep { return owner.shell(ctx, selfTestShellQuick) },
		func(ctx context.Context) selfTestStep { return owner.shell(ctx, selfTestShellCancel) },
	)
	if git {
		steps = append(steps, func(ctx context.Context) selfTestStep { return owner.shell(ctx, selfTestShellGitVersion) })
	}
	for index, step := range steps {
		if ctx.Err() != nil {
			return report
		}
		result := step(ctx)
		report.Steps = append(report.Steps, result)
		if result.Status != "pass" {
			if result.Status == "fail" {
				report.Status = "fail"
				if index >= 4 && index < 4+len(checks) && ctx.Err() == nil {
					for _, skipped := range checks[index-3:] {
						skipped.Status = "not_tested"
						report.Steps = append(report.Steps, skipped)
					}
					cleanup := owner.cleanup(ctx)
					report.Steps = append(report.Steps, cleanup)
					if cleanup.Status == "unknown" {
						report.Status = "unknown"
					}
				}
			}
			return report
		}
	}
	if !directory {
		report.Steps = append(report.Steps, selfTestStep{Name: "directory search", Status: "not_tested"})
	}
	report.Steps = append(report.Steps, selfTestStep{Name: "git and hooks", Status: "not_tested"})
	report.Status = "partial"
	return report
}

func copySelfTestReport(in selfTestReport) selfTestReport {
	out := in
	out.Steps = append([]selfTestStep(nil), in.Steps...)
	return out
}

// runSelfTestPlan executes each step at most once. All file effects and their
// cleanup finish before read-only process checks, so an unverified process
// descendant cannot authorize deletion of the fixture. Unknown and failures
// stop the plan and retain their original operation IDs.
func runSelfTestPlan(ctx context.Context, owner selfTestPlanOwner) selfTestReport {
	report := selfTestReport{Status: "unknown"}
	if ctx == nil || ctx.Err() != nil || owner == nil {
		return report
	}
	steps := []func(context.Context) selfTestStep{
		owner.create, owner.write, owner.edit, owner.observe, owner.cleanup,
		func(ctx context.Context) selfTestStep { return owner.shell(ctx, selfTestShellQuick) },
		func(ctx context.Context) selfTestStep { return owner.shell(ctx, selfTestShellCancel) },
	}
	for _, step := range steps {
		if ctx.Err() != nil {
			return report
		}
		result := step(ctx)
		report.Steps = append(report.Steps, result)
		if result.Status != "pass" {
			if result.Status == "fail" {
				report.Status = "fail"
			}
			return report
		}
	}
	// This plan does not yet exercise the workspace read/search catalogue or
	// Git/hook capabilities. A green subset is not a full diagnostic pass.
	report.Steps = append(report.Steps,
		selfTestStep{Name: "workspace reads", Status: "not_tested"},
		selfTestStep{Name: "git and hooks", Status: "not_tested"},
	)
	report.Status = "partial"
	return report
}

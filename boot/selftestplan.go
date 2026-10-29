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
	out := runSelfTestPlan(ctx, e.owner)
	e.mu.Lock()
	e.result, e.finished = copySelfTestReport(out), true
	e.mu.Unlock()
	return copySelfTestReport(out)
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
	report.Status = "pass"
	return report
}

package boot

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// durableSelfTestExecution admits the original parent before invoking the
// plan, including its authority refresh. Existing Prepared is observation,
// never permission to dispatch any child. A failed Save is not retried.
type durableSelfTestExecution struct {
	mu                sync.Mutex
	started, finished bool
	result            selfTestReport
	gate              *selfTestParentGate
	uncertain         bool
	binding           state.SelfTestBinding
	repository        port.SelfTestRepository
	preflight         func(context.Context) error
	execution         *selfTestExecution
}

func (d *durableSelfTestExecution) execute(ctx context.Context) selfTestReport {
	unknown := selfTestReport{Status: "unknown"}
	if d == nil || ctx == nil || ctx.Err() != nil || d.repository == nil || d.preflight == nil || d.execution == nil || !d.binding.Valid() {
		return unknown
	}
	d.mu.Lock()
	if d.started {
		if d.finished {
			unknown = copySelfTestReport(d.result)
		}
		d.mu.Unlock()
		return unknown
	}
	d.started = true
	d.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	if d.gate != nil && !d.gate.begin(cancel) {
		cancel()
		d.mu.Lock()
		d.result, d.finished = unknown, true
		d.mu.Unlock()
		return unknown
	}
	out := d.executeOnce(bounded)
	cancel()
	if d.gate != nil {
		d.gate.finish(d.uncertain)
	}
	d.mu.Lock()
	d.result, d.finished = copySelfTestReport(out), true
	d.mu.Unlock()
	return copySelfTestReport(out)
}

func (d *durableSelfTestExecution) executeOnce(ctx context.Context) selfTestReport {
	unknown := selfTestReport{Status: "unknown"}
	if d.preflight(ctx) != nil {
		return unknown
	}
	prepared, err := state.RestoreSelfTest(d.binding, state.Prepared, nil)
	if err != nil {
		return unknown
	}
	d.uncertain = true
	admission, err := d.repository.AdmitSelfTest(ctx, prepared)
	if err != nil || admission.Record == nil || admission.Record.Binding() != d.binding {
		return unknown
	}
	if admission.Status == port.MutationExisting {
		if admission.Record.Phase() == state.Completed || admission.Record.Phase() == state.Failed {
			d.uncertain = false
		}
		return observeSelfTestState(admission.Record)
	}
	if admission.Status != port.MutationAdmitted || admission.Record.Phase() != state.Prepared {
		return unknown
	}
	out := d.execution.execute(ctx)
	result := state.SelfTestResult{Status: out.Status, Steps: make([]state.SelfTestStep, 0, len(out.Steps))}
	phase := state.OutcomeUnknown
	if out.Status == "partial" {
		phase = state.Completed
	}
	if out.Status == "fail" {
		phase, result.Status = state.Failed, "failed"
	}
	for _, step := range out.Steps {
		result.Steps = append(result.Steps, state.SelfTestStep{Name: step.Name, Status: step.Status, Code: step.Code, Operation: step.Operation, Handle: step.Handle, CancelOperation: step.CancelOperation, DescendantCleanup: step.DescendantCleanup})
	}
	terminal, err := state.RestoreSelfTest(d.binding, phase, &result)
	if err != nil || d.repository.SaveSelfTest(ctx, terminal) != nil {
		out.Status = "unknown"
		return out
	}
	if phase != state.OutcomeUnknown {
		d.uncertain = false
	}
	return out
}

func observeSelfTestState(record *state.SelfTestState) selfTestReport {
	out := selfTestReport{Status: "unknown"}
	if record == nil || record.Phase() == state.Prepared {
		return out
	}
	result := record.Result()
	if result == nil {
		return out
	}
	out.Status = result.Status
	if result.Status == "failed" {
		out.Status = "fail"
	}
	for _, step := range result.Steps {
		out.Steps = append(out.Steps, selfTestStep{Name: step.Name, Status: step.Status, Code: step.Code, Operation: step.Operation, Handle: step.Handle, CancelOperation: step.CancelOperation, DescendantCleanup: step.DescendantCleanup})
	}
	return out
}

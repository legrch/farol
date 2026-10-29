package boot

import (
	"context"
	"sync"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// durableSelfTestExecution admits the original parent before invoking the
// plan, including its authority refresh. Existing Prepared is observation,
// never permission to dispatch any child. A failed Save is not retried.
type durableSelfTestExecution struct {
	mu                                                             sync.Mutex
	started, finished                                              bool
	reservationAttempted, reservationAdmitted, reservationConsumed bool
	reservationRunning                                             bool
	reservationMayExist                                            bool
	reservationContext                                             context.Context
	reservationCancel                                              context.CancelFunc
	reservationFinish                                              sync.Once
	reservationBudget                                              time.Duration
	reservationTimer                                               *time.Timer
	result                                                         selfTestReport
	gate                                                           *selfTestParentGate
	ledger                                                         *SettingsMutationIngress
	uncertain                                                      bool
	binding                                                        state.SelfTestBinding
	repository                                                     port.SelfTestRepository
	preflight                                                      func(context.Context) error
	execution                                                      *selfTestExecution
	originSlot                                                     *connectorSlot
	originPublication                                              wire.ComputerAuthorityPublication
}

func (d *durableSelfTestExecution) execute(ctx context.Context) selfTestReport {
	unknown := selfTestReport{Status: "unknown"}
	if d == nil || ctx == nil || ctx.Err() != nil || d.repository == nil || d.preflight == nil || d.execution == nil || !d.binding.Valid() {
		return unknown
	}
	d.mu.Lock()
	if d.started || d.reservationAttempted {
		if d.finished {
			unknown = copySelfTestReport(d.result)
		}
		d.mu.Unlock()
		return unknown
	}
	d.started = true
	d.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	admitted := true
	if d.ledger != nil {
		admitted = d.ledger.beginSelfTestParent(d.binding.Identity.OperationID, cancel)
	} else if d.gate != nil {
		admitted = d.gate.begin(d.binding.Identity.OperationID, cancel)
	}
	if !admitted {
		cancel()
		d.mu.Lock()
		d.result, d.finished = unknown, true
		d.mu.Unlock()
		return unknown
	}
	out := d.executeOnce(bounded)
	cancel()
	if d.ledger != nil {
		d.ledger.selfTestParent.finish(d.uncertain)
	} else if d.gate != nil {
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
	return d.executePrepared(ctx)
}

// reserveForStart records the parent once before the host dispatches the
// effect. Only this live owner gets a single in-memory permit; an existing
// Prepared record, including one from a prior process, is never a permit.
func (d *durableSelfTestExecution) reserveForStart(ctx context.Context) bool {
	if d == nil || ctx == nil || ctx.Err() != nil || d.repository == nil || d.preflight == nil || d.execution == nil || !d.binding.Valid() {
		return false
	}
	d.mu.Lock()
	if d.reservationAttempted || d.reservationConsumed || d.started {
		d.mu.Unlock()
		return false
	}
	d.reservationAttempted = true
	d.mu.Unlock()
	budget := d.reservationBudget
	if budget <= 0 || budget > 30*time.Second {
		budget = 30 * time.Second
	}
	hold, cancelHold := context.WithCancel(context.Background())
	admitted := true
	if d.ledger != nil {
		admitted = d.ledger.beginSelfTestParent(d.binding.Identity.OperationID, cancelHold)
	} else if d.gate != nil {
		admitted = d.gate.begin(d.binding.Identity.OperationID, cancelHold)
	}
	if !admitted {
		cancelHold()
		return false
	}
	d.mu.Lock()
	d.reservationContext, d.reservationCancel = hold, cancelHold
	d.reservationTimer = time.AfterFunc(budget, cancelHold)
	d.mu.Unlock()
	done := make(chan struct{})
	context.AfterFunc(hold, func() {
		<-done
		d.mu.Lock()
		running := d.reservationRunning
		uncertain := d.reservationMayExist
		if d.reservationTimer != nil {
			d.reservationTimer.Stop()
		}
		if !running {
			d.started, d.reservationConsumed = true, true
		}
		d.mu.Unlock()
		if !running {
			d.finishReservation(uncertain)
		}
	})
	defer close(done)
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(hold, cancel)
	defer func() { stop(); cancel() }()
	if d.preflight(bounded) != nil {
		cancelHold()
		return false
	}
	prepared, err := state.RestoreSelfTest(d.binding, state.Prepared, nil)
	if err != nil {
		cancelHold()
		return false
	}
	d.mu.Lock()
	d.reservationMayExist = true
	d.mu.Unlock()
	admission, err := d.repository.AdmitSelfTest(bounded, prepared)
	if err != nil || admission.Status != port.MutationAdmitted || admission.Record == nil || admission.Record.Binding() != d.binding || admission.Record.Phase() != state.Prepared || bounded.Err() != nil {
		cancelHold()
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.started || d.reservationConsumed || hold.Err() != nil {
		cancelHold()
		return false
	}
	d.reservationAdmitted = true
	return true
}

func (d *durableSelfTestExecution) finishReservation(uncertain bool) {
	d.reservationFinish.Do(func() {
		if d.ledger != nil {
			d.ledger.selfTestParent.finish(uncertain)
		} else if d.gate != nil {
			d.gate.finish(uncertain)
		}
	})
}

// executeReserved consumes the permit before any gate or journal work. A
// missed acknowledgement or reconstructed owner cannot dispatch the run.
func (d *durableSelfTestExecution) executeReserved(ctx context.Context) selfTestReport {
	unknown := selfTestReport{Status: "unknown"}
	if d == nil {
		return unknown
	}
	d.mu.Lock()
	if d.reservationConsumed || d.started {
		d.mu.Unlock()
		return unknown
	}
	d.reservationConsumed, d.started = true, true
	if !d.reservationAdmitted || ctx == nil || ctx.Err() != nil || d.repository == nil || d.preflight == nil || d.execution == nil || !d.binding.Valid() || d.reservationContext == nil || d.reservationContext.Err() != nil {
		cancel := d.reservationCancel
		d.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return unknown
	}
	d.reservationRunning = true
	if d.reservationTimer != nil {
		d.reservationTimer.Stop()
	}
	hold, cancelHold := d.reservationContext, d.reservationCancel
	d.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(hold, cancel)
	d.uncertain = true
	if d.preflight(bounded) == nil {
		original, err := d.repository.LoadSelfTest(bounded, d.binding)
		if err == nil && original != nil && original.Binding() == d.binding && original.Phase() == state.Prepared {
			unknown = d.executePrepared(bounded)
		}
	}
	stop()
	cancel()
	cancelHold()
	d.finishReservation(d.uncertain)
	d.mu.Lock()
	d.result, d.finished = copySelfTestReport(unknown), true
	d.mu.Unlock()
	return copySelfTestReport(unknown)
}

func (d *durableSelfTestExecution) executePrepared(ctx context.Context) selfTestReport {
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

package boot

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

// Budget metadata only, set by the closed routed effect ingress. It carries no
// operation identity, admission, authority or provider selection. The Task
// service retains the total context for lineage/journal settlement; its existing
// selected provider receives the earlier execution context at the consumer port.
type taskExecutionDeadlineKey struct{}

func taskEffectContext(parent context.Context, millis string, now time.Time) (context.Context, context.CancelFunc, error) {
	if err := parent.Err(); err != nil {
		return nil, nil, err
	}
	value, err := strconv.ParseInt(millis, 10, 64)
	if err != nil || value <= 0 || strconv.FormatInt(value, 10) != millis || value > now.UnixMilli()+29000 {
		return nil, nil, task.ErrInvalid
	}
	settlement := time.UnixMilli(value)
	if !settlement.After(now) {
		return nil, nil, task.ErrInvalid
	}
	execution := settlement.Add(-2 * time.Second)
	if !execution.After(now) {
		return nil, nil, task.ErrInvalid
	}
	// Preserve the original absolute budget. WithDeadline retains any earlier
	// caller ceiling without moving this metadata or restarting either budget.
	total, cancel := context.WithDeadline(parent, settlement)
	return context.WithValue(total, taskExecutionDeadlineKey{}, execution), cancel, nil
}

type taskBoundedProvider struct{ port.Provider }
type taskBoundedObservedProvider struct {
	*taskBoundedProvider
	observed port.ObservedProvider
}

func taskDeadlineProvider(selected port.Provider) port.Provider {
	bounded := &taskBoundedProvider{selected}
	if observed, ok := selected.(port.ObservedProvider); ok {
		return &taskBoundedObservedProvider{bounded, observed}
	}
	return bounded
}

func taskProviderContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if deadline, ok := ctx.Value(taskExecutionDeadlineKey{}).(time.Time); ok {
		return context.WithDeadline(ctx, deadline)
	}
	return ctx, func() {}
}

func (p *taskBoundedProvider) Supports(ctx context.Context, binding task.Binding) (task.Capabilities, error) {
	execution, cancel := taskProviderContext(ctx)
	defer cancel()
	if err := taskBudgetError(execution); err != nil {
		return task.Capabilities{}, err
	}
	capabilities, err := p.Provider.Supports(execution, binding)
	if err != nil {
		return capabilities, err
	}
	// A provider may return success after waiting past its context deadline.
	// That evidence cannot authorize a new admission after execution expired.
	if err := taskBudgetError(execution); err != nil {
		return task.Capabilities{}, err
	}
	return capabilities, nil
}

func taskBudgetError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Timers may not yet have delivered Done at the instant of the check.
	if deadline, ok := ctx.Deadline(); ok && !deadline.After(time.Now()) {
		return context.DeadlineExceeded
	}
	return nil
}

func taskBeforeDispatch(ctx, execution context.Context) (task.Receipt, error) {
	// Parent cancellation is not proof that an earlier effect was refused.
	if err := taskBudgetError(ctx); err != nil {
		return task.Receipt{}, err
	}
	if err := taskBudgetError(execution); err != nil {
		if _, budgeted := ctx.Value(taskExecutionDeadlineKey{}).(time.Time); budgeted && errors.Is(err, context.DeadlineExceeded) {
			// Only this dispatch has not begun. Settle its original admitted
			// intent using the outer context; do not cancel or retry a provider.
			return task.Receipt{State: task.Rejected, Code: "TASK_REQUEST_DEADLINE_EXPIRED"}, nil
		}
		return task.Receipt{}, err
	}
	return task.Receipt{}, nil
}

func (p *taskBoundedProvider) Dispatch(ctx context.Context, dispatch port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	execution, cancel := taskProviderContext(ctx)
	defer cancel()
	if receipt, err := taskBeforeDispatch(ctx, execution); err != nil || receipt.State == task.Rejected {
		return receipt, err
	}
	return p.Provider.Dispatch(execution, dispatch, progress)
}

func (p *taskBoundedObservedProvider) DispatchObserved(ctx context.Context, dispatch port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	execution, cancel := taskProviderContext(ctx)
	defer cancel()
	if receipt, err := taskBeforeDispatch(ctx, execution); err != nil || receipt.State == task.Rejected {
		return receipt, err
	}
	// Keep the original callback owners and retained observation lifetime. This
	// wrapper shortens the selected execution, never replaces its event sink.
	return p.observed.DispatchObserved(execution, dispatch, progress, record)
}

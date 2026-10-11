package process

import (
	"context"
	"slices"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// NewRootScopedSupervisedPreparer joins the explicitly qualified platform to the
// existing reservation, measurement and watchdog owners. It dispatches nothing.
// Boot must authenticate the support descriptor before constructing strategy;
// this constructor supplies neither a release qualification nor product wiring.
func NewRootScopedSupervisedPreparer(runtimeID string, template Command, selection SeatbeltSelection, strategy *RootScopedPlatformStrategy, watchdog WatchdogSelection, execution context.Context, clock port.Clock) (*SupervisedPreparer, error) {
	if strategy == nil || strategy.frozen == nil || selection.FilePolicy != authority.RootScopedFiles {
		return nil, &processsvc.NativeFailure{}
	}
	policy, err := NewSeatbelt(selection, platformPendingQualification{})
	if err != nil {
		return nil, err
	}
	// The producer owns the explicit environment. An omitted template selects
	// that environment; a supplied template must match it exactly. Neither path
	// inherits host variables or lets boot duplicate the confinement policy.
	environment := policy.Environment(template.Write)
	if template.Environment != nil && !slices.Equal(template.Environment, environment) {
		return nil, &processsvc.NativeFailure{}
	}
	template.Environment = environment
	preparer, err := NewSupervisedPreparer(runtimeID, template, policy, watchdog, execution, clock)
	if err != nil {
		return nil, err
	}
	preparer.boundary.strategy = strategy
	return preparer, nil
}

// The selection-time marker can never admit a native launch. Only the original
// StartLease binds a real invocation qualification to its immutable deadline.
type platformPendingQualification struct{}

func (platformPendingQualification) Qualify(context.Context, Command) error {
	return &processsvc.NativeFailure{}
}

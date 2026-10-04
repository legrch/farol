package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"time"
)

// Private native boundary: CPU tests inject preflight/exec without any OS calls.
// This is one held dispatch, never a scheduler, task engine or authority owner.
type heldBoundary interface {
	Prepare(Command) (func() error, error)
	Exec(Command) error
}

func runHeldGuest(ctx context.Context, command, wrapped Command, qualification *NativeQualification, deadline time.Time, release, parentGone <-chan struct{}, ready func(context.Context) error, closeControl func() error, native heldBoundary) error {
	if err := qualification.claimExec(command, wrapped, deadline); err != nil {
		return err
	}
	if ctx == nil || ctx.Err() != nil || release == nil || parentGone == nil || ready == nil || closeControl == nil || native == nil || qualification.clock == nil || !qualification.clock.Now().Before(deadline) {
		return &processsvc.NativeFailure{}
	}
	bounded, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	select {
	case <-parentGone:
		return &processsvc.NativeFailure{}
	default:
	}
	if qualification.Qualify(bounded, wrapped) != nil {
		return &processsvc.NativeFailure{}
	}
	// Complete preflight before either real same-child Ready response is enabled.
	closeImage, err := native.Prepare(copyCommand(command))
	if closeImage != nil {
		defer closeImage()
	}
	if err != nil || closeImage == nil {
		return &processsvc.NativeFailure{}
	}
	if bounded.Err() != nil || !qualification.clock.Now().Before(deadline) {
		return &processsvc.NativeFailure{}
	}
	select {
	case <-parentGone:
		return &processsvc.NativeFailure{}
	default:
	}
	if ready(bounded) != nil {
		return &processsvc.NativeFailure{Unknown: true}
	}
	select {
	case <-bounded.Done():
		return &processsvc.NativeFailure{}
	case <-parentGone:
		return &processsvc.NativeFailure{}
	case <-release:
	}
	select {
	case <-parentGone:
		return &processsvc.NativeFailure{}
	default:
	}
	if qualification.Qualify(bounded, wrapped) != nil {
		return &processsvc.NativeFailure{}
	}
	if closeControl() != nil || bounded.Err() != nil || !qualification.clock.Now().Before(deadline) {
		return &processsvc.NativeFailure{}
	}
	select {
	case <-parentGone:
		return &processsvc.NativeFailure{}
	default:
	}
	// The real syscall succeeds only by not returning. ANY returned value, even
	// nil from a double, is not terminal/success evidence and permits no repeat.
	native.Exec(copyCommand(command))
	return &processsvc.NativeFailure{Unknown: true}
}

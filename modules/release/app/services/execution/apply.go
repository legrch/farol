package execution

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/release/app/port"
)

type ApplyCommand struct{}
type ApplyResult struct{ Result Result }

// Apply runs only after the existing owner admits mutation following the
// original process/continuation proof. Rechecking trees supplies no such proof.
func (s *Service) Apply(ctx context.Context, _ ApplyCommand) (result *ApplyResult, failure error) {
	o, err := s.operation(ctx, "apply")
	if err != nil {
		return nil, err
	}
	e, err := o.entries()
	if err != nil {
		return nil, err
	}
	if !owned(e.App) {
		return nil, o.refuse("app_missing")
	}
	if !owned(e.Staged) {
		return nil, o.refuse("staged_missing")
	}
	if e.Previous.Present || e.Failed.Present || e.RejectedTarget.Present {
		return nil, o.refuse("operation_exists")
	}
	if err := o.verify(port.App, o.request.Source); err != nil {
		return nil, err
	}
	if err := o.verify(port.Staged, o.request.Target); err != nil {
		return nil, err
	}
	if e.App.Identity.Device != e.Staged.Identity.Device {
		return nil, o.refuse("exchange_unsupported")
	}
	if err := o.call(true, func() error { return o.runtime.Prepare(o.ctx) }); err != nil {
		return nil, err
	}
	o.phase = "prepared"
	if err := o.exchange(port.App, port.Staged, e.App.Identity, e.Staged.Identity); err != nil {
		return nil, err
	}
	// The exchange returned success. On every later failure, compensate only
	// while the original runtime can still fence its route and identify the pair.
	// Unknown native effects remain fenced; startup reconciles their actual bytes.
	defer func() {
		if failure == nil || o.ctx.Err() != nil {
			return
		}
		original := failure
		phase, err := o.runtime.ReadPhase(o.ctx)
		if err == nil {
			o.phase = phase
			result, err = o.reject(e.Staged.Identity, e.App.Identity)
		}
		if err != nil {
			if refused, ok := err.(*Failure); ok {
				copy := *refused
				copy.Cause = errors.Join(original, copy.Cause)
				failure = &copy
			} else {
				failure = errors.Join(original, err)
			}
			return
		}
		result.Result.Code = "apply_failed"
		var refused *Failure
		if errors.As(original, &refused) && refused.Code == "target_verification" {
			result.Result.Code = "target_verification"
		}
		failure = nil
	}()
	if err := o.verify(port.Staged, o.request.Source); err != nil {
		return nil, err
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	if err := o.rename(port.Staged, port.Previous, e.App.Identity); err != nil {
		return nil, err
	}
	if err := o.write("new_installed"); err != nil {
		return nil, err
	}
	match := false
	if err := o.call(false, func() error {
		var err error
		match, err = o.runtime.MatchesTree(o.ctx, port.App, o.request.Target)
		return err
	}); err != nil {
		return nil, err
	}
	if !match {
		return nil, o.refuse("target_verification")
	}
	if err := o.write("verified"); err != nil {
		return nil, err
	}
	return &ApplyResult{Result: Result{Phase: o.phase}}, nil
}

func (o *operation) reject(target, source port.HelperIdentity) (*ApplyResult, error) {
	e, err := o.entries()
	if err != nil {
		return nil, err
	}
	if !owned(e.App) || e.App.Identity != target {
		return nil, o.refuse("target_uncertain")
	}
	predecessor := port.Previous
	if !e.Previous.Present && owned(e.Staged) && e.Staged.Identity == source {
		predecessor = port.Staged
	}
	pair := e.Previous
	if predecessor == port.Staged {
		pair = e.Staged
	}
	if !owned(pair) || pair.Identity != source || (predecessor == port.Previous && e.Staged.Present) || e.Failed.Present || e.RejectedTarget.Present {
		return nil, o.refuse("rollback_pair")
	}
	if err := o.verify(predecessor, o.request.Source); err != nil {
		return nil, err
	}
	if err := o.write("rollback_started"); err != nil {
		return nil, err
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	// Reverse operand order for an early rollback: this is compensation, not
	// another attempt at the original App/Staged exchange.
	if predecessor == port.Staged {
		err = o.exchange(port.Staged, port.App, source, target)
	} else {
		err = o.exchange(port.App, port.Previous, target, source)
	}
	if err != nil {
		return nil, err
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	if err := o.rename(predecessor, port.Failed, target); err != nil {
		return nil, err
	}
	if err := o.call(true, func() error { return o.runtime.RejectTarget(o.ctx, target) }); err != nil {
		return nil, err
	}
	if err := o.verify(port.App, o.request.Source); err != nil {
		return nil, err
	}
	if err := o.write("rolled_back"); err != nil {
		return nil, err
	}
	return &ApplyResult{Result: Result{Phase: o.phase, Code: "target_verification"}}, nil
}

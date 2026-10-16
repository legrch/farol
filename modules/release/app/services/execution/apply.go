package execution

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

type ApplyCommand struct{}
type ApplyResult struct{ Result Result }

// Apply runs only after the existing owner admits mutation following the
// original process/continuation proof. Rechecking trees supplies no such proof.
func (s *Service) Apply(ctx context.Context, _ ApplyCommand) (*ApplyResult, error) {
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
		return o.reject(e.Staged.Identity, e.App.Identity)
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
	if !owned(e.Previous) || e.Previous.Identity != source || e.Staged.Present || e.Failed.Present || e.RejectedTarget.Present {
		return nil, o.refuse("rollback_pair")
	}
	if err := o.verify(port.Previous, o.request.Source); err != nil {
		return nil, err
	}
	if err := o.write("rollback_started"); err != nil {
		return nil, err
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	if err := o.exchange(port.App, port.Previous, target, source); err != nil {
		return nil, err
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	if err := o.rename(port.Previous, port.Failed, target); err != nil {
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

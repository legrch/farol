package execution

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

type RollbackCommand struct{}
type RollbackResult struct{ Result Result }

func (s *Service) Rollback(ctx context.Context, _ RollbackCommand) (*RollbackResult, error) {
	o, err := s.operation(ctx, "rollback")
	if err != nil {
		return nil, err
	}
	if release.PredecessorStateUnqualified(o.request.Source.Version, o.request.Target.Version) {
		return nil, o.refuse("predecessor_state_unqualified")
	}
	phase := ""
	if err := o.call(false, func() error { var err error; phase, err = o.runtime.ReadPhase(o.ctx); return err }); err != nil {
		return nil, err
	}
	switch phase {
	case "verified", "completed", "launch_requested":
		o.phase = phase
	default:
		return nil, o.refuse("rollback_phase")
	}
	e, err := o.entries()
	if err != nil {
		return nil, err
	}
	if !owned(e.App) || !owned(e.Previous) || e.Staged.Present || e.Failed.Present || e.RejectedTarget.Present {
		return nil, o.refuse("rollback_pair")
	}
	if err := o.verify(port.App, o.request.Target); err != nil {
		return nil, err
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
	if err := o.exchange(port.App, port.Previous, e.App.Identity, e.Previous.Identity); err != nil {
		return nil, err
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	if err := o.rename(port.Previous, port.Failed, e.App.Identity); err != nil {
		return nil, err
	}
	if err := o.verify(port.App, o.request.Source); err != nil {
		return nil, err
	}
	if err := o.write("rolled_back"); err != nil {
		return nil, err
	}
	return &RollbackResult{Result: Result{Phase: o.phase}}, nil
}

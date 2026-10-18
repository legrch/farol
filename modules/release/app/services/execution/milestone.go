package execution

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

// AdmittedRuntime is the existing installation runtime plus its read-only
// projection. Supplying it is trusted composition, never a grant from readiness.
type AdmittedRuntime interface {
	port.HelperInstallationRuntime
	port.HelperInstallationObservation
}

// Milestone composes existing policy owners for one immutable parsed request.
// It does not own transport, authenticate a launcher, acquire locks, infer Quit,
// create a journal admission, or turn a terminal value into startup proof.
// Copies share the single consumed execution attempt across all three actions.
type Milestone struct {
	request  port.HelperRequest
	attempt  chan struct{}
	recovery port.HelperRecoveryPolicies
}

func NewMilestone(ctx context.Context, r port.HelperRequest, recovery ...port.HelperRecoveryPolicies) (*Milestone, error) {
	if ctx == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	if err := ctx.Err(); err != nil {
		return nil, &Failure{Code: "canceled", Phase: "refused", Cause: err}
	}
	if r.Action != "apply" && r.Action != "recover" && r.Action != "rollback" {
		return nil, &Failure{Code: "input", Phase: "refused"}
	}
	if len(recovery) > 1 {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	s := &Milestone{request: captureRequest(r), attempt: make(chan struct{}, 1)}
	if len(recovery) == 1 {
		s.recovery = recovery[0]
	}
	return s, nil
}

func (s *Milestone) Inspect(ctx context.Context, observation port.HelperInstallationObservation) (*Readiness, error) {
	if s == nil || s.attempt == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	return InspectInstallation(ctx, s.request, observation, s.recovery)
}

// Execute is called only AFTER actual native admission. Apply/rollback and live
// recovery require the pre-ACK observation, then repeat it before the first
// effect. Offline recovery keeps the original crash-gap reconciliation path.
// Unknown errors never trigger another policy, compensation or relaunch.
func (s *Milestone) Execute(ctx context.Context, native AdmittedRuntime, ready *Readiness, launch port.HelperRelaunchEffects) (*Result, error) {
	if s == nil || s.attempt == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	select {
	case s.attempt <- struct{}{}:
	default:
		return nil, &Failure{Code: "execution_attempt_unknown", Phase: "refused", Uncertain: true}
	}
	if ctx == nil || native == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	o := &operation{ctx: ctx, request: s.request, runtime: native, observation: native, phase: "refused"}
	if err := o.check(); err != nil {
		return nil, err
	}
	if s.request.Action != "recover" || s.request.Relaunch {
		if ready == nil || !sameHelperRequest(ready.request, s.request) {
			return nil, o.refuse("readiness_required")
		}
		if err := ready.Recheck(ctx, native); err != nil {
			return nil, err
		}
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	var result Result
	switch s.request.Action {
	case "apply", "rollback":
		service, err := NewCaptured(ctx, s.request, native)
		if err != nil {
			return nil, err
		}
		if s.request.Action == "apply" {
			applied, err := service.Apply(ctx, ApplyCommand{})
			if err != nil {
				return nil, err
			}
			if applied == nil {
				return nil, &Failure{Code: "internal", Phase: "refused", Internal: true, Uncertain: true}
			}
			result = applied.Result
		} else {
			rolled, err := service.Rollback(ctx, RollbackCommand{})
			if err != nil {
				return nil, err
			}
			if rolled == nil {
				return nil, &Failure{Code: "internal", Phase: "refused", Internal: true, Uncertain: true}
			}
			result = rolled.Result
		}
	case "recover":
		if s.recovery == nil {
			return nil, &Failure{Code: "recovery_policy_required", Phase: "refused", Internal: true}
		}
		service, err := s.recovery.Bind(ctx, captureRequest(s.request), native)
		if err != nil {
			return nil, err
		}
		if service == nil {
			return nil, &Failure{Code: "recovery_policy_required", Phase: "refused", Internal: true}
		}
		phase, err := service.Reconcile(ctx)
		if err != nil {
			return nil, err
		}
		result.Phase = phase
	}
	// The original native runtime retains incomplete-effect uncertainty on return.
	// Once policy has run, any later failure cannot be a clean preflight refusal.
	o.effected = true
	o.phase = result.Phase
	if s.request.Relaunch && result.Phase == "verified" && result.Code == "" {
		if err := o.completeLaunch(launch); err != nil {
			known, ok := err.(*Failure)
			if !ok || known.Code != "launch_failed" || known.Phase != "launch_requested" || known.Internal || known.Uncertain {
				return nil, err
			}
			result.Code = "launch_failed"
		}
		result.Phase = o.phase
	}
	if err := o.fence(); err != nil {
		return nil, err
	}
	return &result, nil
}

func (o *operation) completeLaunch(launch port.HelperRelaunchEffects) error {
	if launch == nil {
		return &Failure{Code: "launch_unavailable", Phase: o.phase, Uncertain: true}
	}
	phase := ""
	if err := o.call(false, func() error { var err error; phase, err = o.runtime.ReadPhase(o.ctx); return err }); err != nil {
		return err
	}
	if phase != "verified" {
		return o.refuse("launch_phase")
	}
	if err := o.verify(port.App, o.request.Target); err != nil {
		return err
	}
	var private *string
	if o.request.InstallLocation != nil && *o.request.InstallLocation == "shared" {
		var path string
		if err := o.call(true, func() error { var err error; path, err = launch.CapturePrivateTarget(o.ctx); return err }); err != nil {
			return err
		}
		expected := o.request.Home + "/Library/Application Support/Farol Next Preview/installed-updates/" + o.request.OperationID + "/launch-Farol.app"
		if path != expected {
			return o.refuse("launch_image_unconfirmed")
		}
		private = &path
	}
	if err := o.fence(); err != nil {
		return err
	}
	if err := o.write("launch_requested"); err != nil {
		return err
	}
	var self port.HelperSelfIdentity
	if err := o.call(false, func() error { var err error; self, err = launch.SelfIdentity(o.ctx); return err }); err != nil {
		return err
	}
	if self.PID <= 1 || self.PID > 2147483647 || self.ProcessStart == "" || len(self.ProcessStart) > 128 {
		return o.refuse("launch_helper_identity")
	}
	if err := o.fence(); err != nil {
		return err
	}
	var nativeErr error
	if err := o.call(true, func() error { nativeErr = launch.LaunchTarget(o.ctx, self, private); return nativeErr }); err != nil {
		// Only a direct, actual returned nonzero launch with confirmed native
		// cleanup may settle the original launch_failed result. Opaque/late/
		// unknown outcomes retain uncertainty and never take this path.
		if f, ok := nativeErr.(*port.HelperRecoveryFailure); ok && f != nil && f.Code == "launch_failed" && f.Phase == "refused" && !f.Internal && !f.Uncertain && !uncertainCause(f.Cause) && o.ctx.Err() == nil {
			return &Failure{Code: "launch_failed", Phase: o.phase, Cause: nativeErr}
		}
		return err
	}
	return o.write("completed")
}

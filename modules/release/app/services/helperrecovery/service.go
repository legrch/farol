// Package helperrecovery ports the existing helper's admitted reconciliation
// decisions. Inspect is repeatable observation only; Reconcile consumes one
// attempt. Native custody, verification and journal persistence stay in ports.
package helperrecovery

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

// Failure retains bounded helper Code/Phase and dependency provenance. Its
// closed Error text never publishes dependency messages or untrusted fields.
type Failure struct {
	Code, Phase         string
	Internal, Uncertain bool
	Cause               error
}

func (*Failure) Error() string { return "helper_recovery_failure" }
func (f *Failure) Unwrap() error {
	if f == nil {
		return nil
	}
	return f.Cause
}

func refuse(code, phase string) error { return &Failure{Code: code, Phase: phase} }
func internal(cause error, uncertain bool) error {
	return &Failure{Code: "internal", Phase: "refused", Internal: true, Uncertain: uncertain, Cause: cause}
}

type Service struct {
	request port.HelperRequest
	runtime port.HelperRecoveryRuntime
	attempt chan struct{} // Shared, never released, even across wrapper copies.
}

// Bind independently parses one captured request. Trusted composition supplies
// non-panicking, non-typed-nil ports bound to that same request and real custody.
func Bind(ctx context.Context, input []byte, parser port.HelperRequestParser, runtime port.HelperRecoveryRuntime) (*Service, error) {
	if ctx == nil || parser == nil || runtime == nil {
		return nil, internal(nil, false)
	}
	if err := ctx.Err(); err != nil {
		return nil, canceled(err, false)
	}
	if len(input) < 1 || len(input) > 8192 {
		return nil, refuse("input", "refused")
	}
	r, err := parser.Parse(ctx, append([]byte(nil), input...))
	if err != nil {
		cause := dependencyCause(ctx, err)
		switch err.Error() {
		case "input", "acceptance", "canceled":
			return nil, &Failure{Code: err.Error(), Phase: "refused", Cause: cause}
		default:
			return nil, internal(cause, false)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, canceled(err, false)
	}
	bound := &Service{request: copyRequest(r), runtime: runtime, attempt: make(chan struct{}, 1)}
	if err := ctx.Err(); err != nil {
		return nil, canceled(err, false)
	}
	return bound, nil
}

func copyRequest(r port.HelperRequest) port.HelperRequest {
	if r.Predecessor != nil {
		v := *r.Predecessor
		r.Predecessor = &v
	}
	if r.LeaseIdentity != nil {
		v := *r.LeaseIdentity
		r.LeaseIdentity = &v
	}
	if r.InstallLocation != nil {
		v := *r.InstallLocation
		r.InstallLocation = &v
	}
	return r
}

func canceled(cause error, uncertain bool) error {
	return &Failure{Code: "canceled", Phase: "refused", Uncertain: uncertain, Cause: cause}
}

func (s *Service) operation(ctx context.Context) (*operation, error) {
	if s == nil || s.runtime == nil || s.attempt == nil || ctx == nil {
		return nil, internal(nil, false)
	}
	op := &operation{ctx: ctx, runtime: s.runtime, request: s.request}
	return op, op.check()
}

// Request returns independent values, never a readiness/admission witness.
func (s *Service) Request(ctx context.Context) (port.HelperRequest, error) {
	op, err := s.operation(ctx)
	if err != nil {
		return port.HelperRequest{}, err
	}
	r := copyRequest(s.request)
	if err := op.check(); err != nil {
		return port.HelperRequest{}, err
	}
	return r, nil
}

// Inspect proves only the existing helper's exact pre-Quit pair observation.
// The caller supplies serialized real custody; nil grants no recovery authority.
func (s *Service) Inspect(ctx context.Context) error {
	op, err := s.operation(ctx)
	if err != nil {
		return err
	}
	if err := op.inspect(); err != nil {
		return op.retain(err)
	}
	return op.check()
}

// Reconcile consumes before any IO or cancellation check, including copied or
// concurrent wrappers. The caller holds custody through actual native return;
// neither error nor retained journal phase authorizes a second dispatch.
func (s *Service) Reconcile(ctx context.Context) (string, error) {
	if s == nil || s.attempt == nil {
		return "", internal(nil, false)
	}
	select {
	case s.attempt <- struct{}{}:
	default:
		return "", &Failure{Code: "recovery_attempt_unknown", Phase: "refused", Uncertain: true}
	}
	op, err := s.operation(ctx)
	if err != nil {
		return "", err
	}
	phase, err := op.reconcile()
	if err != nil {
		return "", op.retain(err)
	}
	if err := op.check(); err != nil {
		return "", err
	}
	return phase, nil
}

type operation struct {
	ctx      context.Context
	runtime  port.HelperRecoveryRuntime
	request  port.HelperRequest
	effected bool
}

func (op *operation) check() error {
	if err := op.ctx.Err(); err != nil {
		return canceled(err, op.effected)
	}
	return nil
}

// Capture cancellation alongside the exact dependency failure, never in its
// place. The dependency's classification still decides the outer Failure.
func dependencyCause(ctx context.Context, err error) error {
	if canceled := ctx.Err(); canceled != nil {
		return errors.Join(err, canceled)
	}
	return err
}

// Explicit policy/internal branches also retain all effects already attempted.
func (op *operation) retain(err error) error {
	f, classified := err.(*Failure)
	if !classified || f == nil {
		return internal(dependencyCause(op.ctx, err), op.effected)
	}
	retained := *f
	retained.Uncertain = retained.Uncertain || op.effected
	retained.Cause = dependencyCause(op.ctx, f.Cause)
	return &retained
}

// Scan every joined branch without accepting nested refusal classification.
// An overlarge/cyclic error graph conservatively retains uncertainty.
func dependencyUncertain(err error) bool {
	pending := []error{err}
	remaining := 128
	for len(pending) > 0 {
		if remaining == 0 {
			return true
		}
		remaining--
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if current == nil {
			continue
		}
		if f, classified := current.(*port.HelperRecoveryFailure); classified {
			if f == nil || f.Uncertain {
				return true
			}
		}
		switch wrapped := current.(type) {
		case interface{ Unwrap() []error }:
			causes := wrapped.Unwrap()
			if len(causes) > remaining-len(pending) {
				return true
			}
			pending = append(pending, causes...)
		case interface{ Unwrap() error }:
			pending = append(pending, wrapped.Unwrap())
		}
	}
	return false
}

// Dependency errors win over concurrent cancellation. Only typed, bounded
// original refusals become policy refusals; unexpected errors keep their cause.
func (op *operation) result(err error) error {
	if err != nil {
		cause := dependencyCause(op.ctx, err)
		// Wrapped classification may retain uncertainty, but cannot turn an
		// opaque joined syscall/internal error into an original policy refusal.
		uncertain := op.effected || dependencyUncertain(err)
		f, classified := err.(*port.HelperRecoveryFailure)
		if classified && f != nil && validCode(f.Code) && validPhase(f.Phase) {
			return &Failure{Code: f.Code, Phase: f.Phase, Internal: f.Internal, Uncertain: uncertain, Cause: cause}
		}
		if err == context.Canceled || err == context.DeadlineExceeded {
			return canceled(cause, uncertain)
		}
		return internal(cause, uncertain)
	}
	return op.check()
}

func validCode(v string) bool {
	if len(v) < 1 || len(v) > 80 || v[0] < 'a' || v[0] > 'z' {
		return false
	}
	for _, c := range v[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

func validPhase(v string) bool {
	switch v {
	case "refused", "prepared", "predecessor_saved", "new_installed", "verified", "rollback_started", "rolled_back", "cancelled", "launch_requested", "completed", "cancel_launch_requested", "cancel_completed", "rollback_launch_requested", "rollback_completed":
		return true
	}
	return false
}

func (op *operation) phase() (string, error) {
	if err := op.check(); err != nil {
		return "", err
	}
	p, err := op.runtime.ReadPhase(op.ctx)
	if err := op.result(err); err != nil {
		return "", err
	}
	if p == "refused" || !validPhase(p) {
		return "", internal(nil, false)
	}
	return p, nil
}

func (op *operation) entries() (port.HelperRecoveryEntries, error) {
	if err := op.check(); err != nil {
		return port.HelperRecoveryEntries{}, err
	}
	e, err := op.runtime.Entries(op.ctx)
	if err := op.result(err); err != nil {
		return port.HelperRecoveryEntries{}, err
	}
	return e, nil
}

func (op *operation) matches(e port.HelperRecoveryEntry, b port.HelperBuild) (bool, error) {
	if err := op.check(); err != nil {
		return false, err
	}
	match, err := op.runtime.MatchesTree(op.ctx, e, b)
	if err := op.result(err); err != nil {
		return false, err
	}
	return match, nil
}

func (op *operation) pair(a port.HelperRecoveryEntry, ab port.HelperBuild, b port.HelperRecoveryEntry, bb port.HelperBuild) (bool, error) {
	match, err := op.matches(a, ab)
	if err != nil || !match {
		return false, err
	}
	return op.matches(b, bb)
}

func (op *operation) verify(e port.HelperRecoveryEntry, b port.HelperBuild) error {
	if err := op.check(); err != nil {
		return err
	}
	return op.result(op.runtime.VerifyTree(op.ctx, e, b))
}

func (op *operation) fence() error {
	if err := op.check(); err != nil {
		return err
	}
	return op.result(op.runtime.Fence(op.ctx))
}

func (op *operation) rename(a, b port.HelperRecoveryEntry, id port.HelperIdentity) error {
	if err := op.check(); err != nil {
		return err
	}
	op.effected = true
	return op.result(op.runtime.Rename(op.ctx, a, b, id))
}

func (op *operation) exchange(a, b port.HelperRecoveryEntry, aid, bid port.HelperIdentity) error {
	if err := op.check(); err != nil {
		return err
	}
	op.effected = true
	return op.result(op.runtime.Exchange(op.ctx, a, b, aid, bid))
}

func (op *operation) write(p string) (string, error) {
	if err := op.check(); err != nil {
		return "", err
	}
	op.effected = true
	if err := op.result(op.runtime.WritePhase(op.ctx, p)); err != nil {
		return "", err
	}
	return p, nil
}

func (op *operation) predecessor() error {
	if release.PredecessorStateUnqualified(op.request.Source.Version, op.request.Target.Version) {
		return refuse("predecessor_state_unqualified", "refused")
	}
	return nil
}

func (op *operation) keepsTarget(phase string) (bool, error) {
	if phase != "rollback_started" {
		return false, nil
	}
	if err := op.predecessor(); err == nil {
		return false, nil
	}
	if op.request.Action == "recover" {
		e, err := op.entries()
		if err != nil {
			return false, err
		}
		if e.App.Present && e.Previous.Present && !e.Staged.Present && !e.Failed.Present && !e.RejectedTarget.Present {
			match, err := op.pair(port.App, op.request.Target, port.Previous, op.request.Source)
			if err != nil {
				return false, err
			}
			if match {
				return true, nil
			}
		}
	}
	return false, refuse("predecessor_state_unqualified", "refused")
}

func oneOf(v string, values ...string) bool {
	for _, candidate := range values {
		if v == candidate {
			return true
		}
	}
	return false
}

func (op *operation) inspect() error {
	phase, err := op.phase()
	if err != nil {
		return err
	}
	keep, err := op.keepsTarget(phase)
	if err != nil || keep {
		return err
	}
	e, err := op.entries()
	if err != nil {
		return err
	}
	if !e.App.Present {
		return refuse("recovery_pair", phase)
	}
	source, target := op.request.Source, op.request.Target
	if oneOf(phase, "prepared", "cancelled", "cancel_launch_requested", "cancel_completed") && !e.Previous.Present && !e.Failed.Present && e.Staged.Present {
		match, err := op.pair(port.App, source, port.Staged, target)
		if err != nil || match {
			return err
		}
		if phase == "prepared" {
			match, err = op.pair(port.App, target, port.Staged, source)
			if err != nil || match {
				return err
			}
		}
	}
	if oneOf(phase, "prepared", "predecessor_saved", "new_installed", "verified", "launch_requested", "completed", "rollback_started") && e.Previous.Present && !e.Staged.Present && !e.Failed.Present {
		match, err := op.pair(port.App, target, port.Previous, source)
		if err != nil || match {
			return err
		}
		if phase == "rollback_started" {
			match, err = op.pair(port.App, source, port.Previous, target)
			if err != nil || match {
				return err
			}
		}
	}
	if oneOf(phase, "rollback_started", "rolled_back", "rollback_launch_requested", "rollback_completed") && !e.Previous.Present && !e.Staged.Present && e.Failed.Present {
		match, err := op.matches(port.App, source)
		if err != nil {
			return err
		}
		if match && e.Failed.Directory && e.Failed.OwnedByEffectiveUser {
			return nil
		}
	}
	return refuse("recovery_pair", phase)
}

func (op *operation) reconcile() (string, error) {
	phase, err := op.phase()
	if err != nil {
		return "", err
	}
	e, err := op.entries()
	if err != nil {
		return "", err
	}
	source, target := op.request.Source, op.request.Target
	if oneOf(phase, "rollback_started", "rolled_back", "rollback_launch_requested", "rollback_completed") {
		keep, err := op.keepsTarget(phase)
		if err != nil {
			return "", err
		}
		if keep {
			if err := op.fence(); err != nil {
				return "", err
			}
			keep, err = op.keepsTarget(phase)
			if err != nil {
				return "", err
			}
			if !keep {
				return "", refuse("recovery_pair", phase)
			}
			return op.write("verified")
		}
		if e.Staged.Present {
			return "", refuse("rollback_uncertain", phase)
		}
		if phase == "rollback_started" && e.App.Present && e.Previous.Present && !e.Failed.Present {
			match, err := op.pair(port.App, target, port.Previous, source)
			if err != nil {
				return "", err
			}
			if match {
				if err := op.fence(); err != nil {
					return "", err
				}
				if err := op.exchange(port.App, port.Previous, e.App.Identity, e.Previous.Identity); err != nil {
					return "", err
				}
			}
			if err := op.verify(port.App, source); err != nil {
				return "", err
			}
			if err := op.verify(port.Previous, target); err != nil {
				return "", err
			}
			if err := op.fence(); err != nil {
				return "", err
			}
			fresh, err := op.entries()
			if err != nil {
				return "", err
			}
			if !fresh.Previous.Present {
				return "", internal(nil, op.effected)
			}
			if err := op.rename(port.Previous, port.Failed, fresh.Previous.Identity); err != nil {
				return "", err
			}
			return op.write("rolled_back")
		}
		if e.Previous.Present && !e.App.Present && e.Failed.Present && phase == "rollback_started" {
			if err := op.verify(port.Previous, source); err != nil {
				return "", err
			}
			if err := op.fence(); err != nil {
				return "", err
			}
			if err := op.rename(port.Previous, port.App, e.Previous.Identity); err != nil {
				return "", err
			}
			return op.write("rolled_back")
		}
		if e.App.Present && !e.Previous.Present && e.Failed.Present {
			if err := op.verify(port.App, source); err != nil {
				return "", err
			}
			if !e.Failed.Directory || !e.Failed.OwnedByEffectiveUser {
				return "", refuse("failed_type", phase)
			}
			if phase == "rollback_started" {
				if err := op.fence(); err != nil {
					return "", err
				}
				return op.write("rolled_back")
			}
			return phase, nil
		}
		return "", refuse("rollback_uncertain", phase)
	}
	if e.Failed.Present {
		return "", refuse("failed_unexpected", phase)
	}
	if oneOf(phase, "prepared", "cancelled", "cancel_launch_requested", "cancel_completed") && !e.Previous.Present {
		if e.App.Present && e.Staged.Present {
			match, err := op.pair(port.App, source, port.Staged, target)
			if err != nil {
				return "", err
			}
			if match {
				if phase == "prepared" {
					if err := op.fence(); err != nil {
						return "", err
					}
					return op.write("cancelled")
				}
				return phase, nil
			}
			if phase == "prepared" {
				if err := op.verify(port.App, target); err != nil {
					return "", err
				}
				if err := op.verify(port.Staged, source); err != nil {
					return "", err
				}
				if err := op.fence(); err != nil {
					return "", err
				}
				if err := op.rename(port.Staged, port.Previous, e.Staged.Identity); err != nil {
					return "", err
				}
				return op.write("verified")
			}
		}
		return "", refuse("predecessor_missing", phase)
	}
	if !e.Previous.Present {
		return "", refuse("predecessor_missing", phase)
	}
	if err := op.verify(port.Previous, source); err != nil {
		return "", err
	}
	if !e.App.Present {
		if oneOf(phase, "prepared", "predecessor_saved") && e.Staged.Present {
			if err := op.verify(port.Staged, target); err != nil {
				return "", err
			}
			if err := op.predecessor(); err != nil {
				return "", err
			}
			if err := op.fence(); err != nil {
				return "", err
			}
			if err := op.rename(port.Previous, port.App, e.Previous.Identity); err != nil {
				return "", err
			}
			return op.write("rolled_back")
		}
		return "", refuse("app_missing", phase)
	}
	if e.Staged.Present {
		return "", refuse("staged_unexpected", phase)
	}
	if err := op.verify(port.App, target); err != nil {
		return "", err
	}
	if oneOf(phase, "prepared", "predecessor_saved", "new_installed") {
		if err := op.fence(); err != nil {
			return "", err
		}
		return op.write("verified")
	}
	return phase, nil
}

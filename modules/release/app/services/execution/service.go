// Package execution owns admitted helper apply and rollback decisions. Ports
// own native custody and effects; this service opens no route or lease and
// publishes no readiness, continuation, process or relaunch authority.
package execution

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/release/app/port"
)

type Failure struct {
	Code, Phase         string
	Internal, Uncertain bool
	Cause               error
}

func (*Failure) Error() string { return "helper_execution_failure" }
func (f *Failure) Unwrap() error {
	if f == nil {
		return nil
	}
	return f.Cause
}

// Result is an observed terminal policy value, not helper exit or startup proof.
// A completed automatic rollback returns Code=target_verification with
// no error: the failed update is settled, unlike an incomplete effect scope.
type Result struct{ Phase, Code string }

type Service struct {
	request port.HelperRequest
	runtime port.HelperInstallationRuntime
	attempt chan struct{}
}

// Bind independently parses the captured request. Composition supplies trusted
// non-panicking/non-typed-nil ports bound to that same immutable request and the
// existing admitted native owner. Only apply/rollback belong to this service;
// recovery remains the existing helperrecovery application owner.
func Bind(ctx context.Context, input []byte, parser port.HelperRequestParser, runtime port.HelperInstallationRuntime) (*Service, error) {
	bad := func(code string, internal bool, cause error) (*Service, error) {
		return nil, &Failure{Code: code, Phase: "refused", Internal: internal, Cause: cause}
	}
	if ctx == nil || parser == nil || runtime == nil {
		return bad("internal", true, nil)
	}
	if err := ctx.Err(); err != nil {
		return bad("canceled", false, err)
	}
	if len(input) < 1 || len(input) > 8192 {
		return bad("input", false, nil)
	}
	r, err := parser.Parse(ctx, append([]byte(nil), input...))
	if err != nil {
		code, internal := "internal", true
		switch err.Error() {
		case "input", "acceptance", "canceled":
			code, internal = err.Error(), false
		}
		return bad(code, internal, errors.Join(err, ctx.Err()))
	}
	if err := ctx.Err(); err != nil {
		return bad("canceled", false, err)
	}
	return NewCaptured(ctx, r, runtime)
}

// NewCaptured composes the already parsed request from the original helper
// protocol owner. It copies all pointer fields and performs no parsing, native
// work or admission. Only trusted composition of that same captured request and
// an independently admitted runtime may use it; values grant no authority.
func NewCaptured(ctx context.Context, r port.HelperRequest, runtime port.HelperInstallationRuntime) (*Service, error) {
	if ctx == nil || runtime == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	if err := ctx.Err(); err != nil {
		return nil, &Failure{Code: "canceled", Phase: "refused", Cause: err}
	}
	if r.Action != "apply" && r.Action != "rollback" {
		return nil, &Failure{Code: "input", Phase: "refused"}
	}
	return &Service{request: captureRequest(r), runtime: runtime, attempt: make(chan struct{}, 1)}, nil
}

func captureRequest(r port.HelperRequest) port.HelperRequest {
	if r.RelaunchPresentation != nil {
		v := *r.RelaunchPresentation
		r.RelaunchPresentation = &v
	}
	if r.InstallLocation != nil {
		v := *r.InstallLocation
		r.InstallLocation = &v
	}
	if r.Predecessor != nil {
		v := *r.Predecessor
		r.Predecessor = &v
	}
	if r.LeaseIdentity != nil {
		v := *r.LeaseIdentity
		r.LeaseIdentity = &v
	}
	return r
}

type operation struct {
	ctx         context.Context
	request     port.HelperRequest
	runtime     port.HelperInstallationRuntime
	observation port.HelperRecoveryObservation
	phase       string
	effected    bool
}

func (s *Service) operation(ctx context.Context, action string) (*operation, error) {
	if s == nil || s.runtime == nil || s.attempt == nil || ctx == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	// One attempt across copies, consumed before cancellation or any native call.
	select {
	case s.attempt <- struct{}{}:
	default:
		return nil, &Failure{Code: "execution_attempt_unknown", Phase: "refused", Uncertain: true}
	}
	o := &operation{ctx: ctx, request: s.request, runtime: s.runtime, observation: s.runtime, phase: "refused"}
	if err := o.check(); err != nil {
		return nil, err
	}
	if s.request.Action != action {
		return nil, o.refuse("input")
	}
	return o, nil
}
func (o *operation) refuse(code string) error {
	return &Failure{Code: code, Phase: o.phase, Uncertain: o.effected}
}
func (o *operation) check() error {
	if err := o.ctx.Err(); err != nil {
		return &Failure{Code: "canceled", Phase: o.phase, Uncertain: o.effected, Cause: err}
	}
	return nil
}
func boundedCode(s string) bool {
	if len(s) < 1 || len(s) > 80 || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for _, c := range s[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
func uncertainCause(err error) bool {
	queue := []error{err}
	for nodes := 0; len(queue) > 0; nodes++ {
		if nodes == 128 {
			return true
		}
		e := queue[0]
		queue = queue[1:]
		if e == nil {
			continue
		}
		if f, ok := e.(*port.HelperRecoveryFailure); ok && (f == nil || f.Uncertain) {
			return true
		}
		if f, ok := e.(*Failure); ok && (f == nil || f.Uncertain) {
			return true
		}
		if many, ok := e.(interface{ Unwrap() []error }); ok {
			children := many.Unwrap()
			if len(children) > 128-len(queue) {
				return true
			}
			queue = append(queue, children...)
		} else if one, ok := e.(interface{ Unwrap() error }); ok {
			queue = append(queue, one.Unwrap())
		}
	}
	return false
}
func (o *operation) call(effect bool, fn func() error) error {
	if err := o.check(); err != nil {
		return err
	}
	err := fn()
	late := o.ctx.Err()
	if err != nil {
		f := &Failure{Code: "internal", Phase: o.phase, Internal: true, Uncertain: o.effected || effect || uncertainCause(err), Cause: errors.Join(err, late)}
		if known, ok := err.(*port.HelperRecoveryFailure); ok && known != nil && boundedCode(known.Code) && known.Phase == "refused" {
			f.Code, f.Internal = known.Code, known.Internal
			f.Uncertain = o.effected || known.Uncertain || uncertainCause(known.Cause)
		}
		return f
	}
	if late != nil {
		return &Failure{Code: "canceled", Phase: o.phase, Uncertain: o.effected || effect, Cause: late}
	}
	if effect {
		o.effected = true
	}
	return nil
}
func (o *operation) entries() (port.HelperRecoveryEntries, error) {
	var v port.HelperRecoveryEntries
	err := o.call(false, func() error { var err error; v, err = o.observation.Entries(o.ctx); return err })
	if err != nil {
		return port.HelperRecoveryEntries{}, err
	}
	return v, nil
}
func (o *operation) verify(entry port.HelperRecoveryEntry, build port.HelperBuild) error {
	return o.call(false, func() error { return o.observation.VerifyTree(o.ctx, entry, build) })
}
func (o *operation) fence() error {
	return o.call(false, func() error { return o.runtime.Fence(o.ctx) })
}
func (o *operation) write(phase string) error {
	if err := o.call(true, func() error { return o.runtime.WritePhase(o.ctx, phase) }); err != nil {
		return err
	}
	o.phase = phase
	return nil
}
func (o *operation) rename(from, to port.HelperRecoveryEntry, id port.HelperIdentity) error {
	return o.call(true, func() error { return o.runtime.Rename(o.ctx, from, to, id) })
}
func (o *operation) exchange(left, right port.HelperRecoveryEntry, leftID, rightID port.HelperIdentity) error {
	return o.call(true, func() error { return o.runtime.Exchange(o.ctx, left, right, leftID, rightID) })
}
func owned(v port.HelperRecoveryEntrySnapshot) bool {
	return v.Present && v.Directory && v.OwnedByEffectiveUser
}

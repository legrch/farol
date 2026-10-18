// Package execution implements the recovery ports with native
// observations, namespace primitives and the existing operation journal. It is
// unselected: it opens no route, acquires no lease and launches no process.
package execution

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"github.com/legrch/farol/modules/release/infra/native/installmove"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

// Config borrows one live helperroutes.WithFiles scope and the existing journal
// for the SAME independently parsed request. Reverify belongs to the existing
// operation owner: it checks actual lease/slot/admission, not caller assertions.
// It must not reenter this runtime or the journal gate. The caller retains every
// borrowed owner through With's actual return. No field alone grants authority.
type Config struct {
	Request port.HelperRequest
	Files   helperroutes.Files
	Journal port.HelperJournalRepository
	// Rejection is required only by WithInstallation. It borrows the same
	// operation descriptor and original JournalAdmission/gate as Journal.
	Rejection port.HelperTargetRejectionRepository
	Until     time.Time
	Reverify  func(context.Context, port.HelperRequest) error
	// Unknown and RetainUnknown belong to the same operation owner. Neither
	// performs I/O or reenters this runtime; retained outcomes survive With.
	Unknown       func() error
	RetainUnknown func(error)
}

type runtime struct {
	mu       sync.Mutex
	config   Config
	original context.Context
	until    time.Time
	active   bool
	attempts map[string]bool
	unknown  error
	view     *port.JournalView
	reader   port.HelperJournalObservationReader
	routes   func(context.Context) error
	effected bool
}

var _ port.HelperRecoveryRuntime = (*runtime)(nil)
var _ port.HelperInstallationRuntime = (*runtime)(nil)

func copyRequest(r port.HelperRequest) port.HelperRequest {
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

func operation(r port.HelperRequest) release.Operation {
	build := func(v port.HelperBuild) release.Build {
		return release.Build{Digest: v.Digest, Version: v.Version, BuildID: v.BuildID}
	}
	return release.Operation{ID: r.OperationID, Source: build(r.Source), Target: build(r.Target)}
}

func fail(code string, internal, uncertain bool, cause error) error {
	return &port.HelperRecoveryFailure{Code: code, Phase: "refused", Internal: internal, Uncertain: uncertain, Cause: cause}
}

// With serializes methods and joins their actual return before ending scope.
// A retained interface refuses after this callback, even with a fresh context.
// Cancellation never closes a borrowed descriptor or abandons a native call.
func With(ctx context.Context, config Config, fn func(port.HelperRecoveryRuntime) error) (result error) {
	return with(ctx, config, config.Files.Reverify, fn)
}

// The route seam is private to package tests; production always uses the live
// helperroutes borrow. It is not a runtime alternate root or admission option.
func with(ctx context.Context, config Config, routes func(context.Context) error, fn func(port.HelperRecoveryRuntime) error) error {
	if config.Journal == nil {
		return fail("internal", true, false, nil)
	}
	return withReader(ctx, config, config.Journal, routes, fn)
}

func withReader(ctx context.Context, config Config, reader port.HelperJournalObservationReader, routes func(context.Context) error, fn func(port.HelperRecoveryRuntime) error) (result error) {
	if ctx == nil || reader == nil || config.Reverify == nil || config.Unknown == nil || config.RetainUnknown == nil || config.Until.IsZero() || fn == nil {
		return fail("internal", true, false, nil)
	}
	if _, err := records.EncodeJournal(records.Journal{Schema: "farol.installed-update-journal/1", Operation: records.Operation{
		ID:     config.Request.OperationID,
		Source: records.Build{Digest: config.Request.Source.Digest, Version: config.Request.Source.Version, BuildID: config.Request.Source.BuildID},
		Target: records.Build{Digest: config.Request.Target.Digest, Version: config.Request.Target.Version, BuildID: config.Request.Target.BuildID},
	}, Phase: "prepared"}); err != nil {
		return fail("input", false, false, err)
	}
	config.Request = copyRequest(config.Request)
	until := config.Until
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(until) {
		until = earlier
	}
	r := &runtime{config: config, original: ctx, until: until, active: true, attempts: make(map[string]bool), routes: routes, reader: reader}
	callbackReturned := false
	defer func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.active = false
		late := r.deadline(ctx, false)
		// A confirmed effect remains part of this scope even when a later
		// method or the application callback fails before its own effect.
		// Transfer that unfinished scope to the existing owner before return.
		if r.effected && r.unknown == nil && (result != nil || late != nil || !callbackReturned) {
			primary := result
			if primary == nil {
				primary = late
			}
			if primary == nil {
				primary = fail("runtime_scope_incomplete", true, true, nil)
			}
			retained := r.classify(primary, true).(*port.HelperRecoveryFailure)
			retained.Uncertain = true
			retained.Cause = errors.Join(retained.Cause, late)
			r.unknown = retained
			r.config.RetainUnknown(retained)
			result = retained
			return
		}
		result = joinResults(result, r.unknown, late)
	}()
	if err := r.invoke(ctx, "", func(effective context.Context) error { return r.fence(effective) }); err != nil {
		return err
	}
	result = fn(r)
	callbackReturned = true
	return result
}

// Preserve a sole original classified cause. Additional independent failures
// remain opaque joined provenance and cannot inherit a nested refusal.
func joinResults(all ...error) error {
	var causes []error
	for _, err := range all {
		if err != nil {
			causes = append(causes, err)
		}
	}
	if len(causes) == 1 {
		return causes[0]
	}
	return errors.Join(causes...)
}

func (r *runtime) deadline(ctx context.Context, effected bool) error {
	if ctx == nil {
		return fail("internal", true, effected, nil)
	}
	var causes []error
	if err := r.original.Err(); err != nil {
		causes = append(causes, err)
	}
	if err := ctx.Err(); err != nil {
		causes = append(causes, err)
	}
	until := r.until
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(until) {
		until = earlier
	}
	if !time.Now().Before(until) {
		causes = append(causes, context.DeadlineExceeded)
	}
	if len(causes) > 0 {
		return fail("canceled", false, effected, errors.Join(causes...))
	}
	return nil
}

// The native context enforces the captured absolute bound even when the
// standard context timer's Err notification has not yet arrived.
type nativeContext struct {
	context.Context
	original context.Context
	until    time.Time
}

func (c nativeContext) Err() error {
	if err := c.original.Err(); err != nil {
		return err
	}
	if err := c.Context.Err(); err != nil {
		return err
	}
	if !time.Now().Before(c.until) {
		return context.DeadlineExceeded
	}
	return nil
}

func (r *runtime) invoke(ctx context.Context, effect string, fn func(context.Context) error) (result error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	wasActive := r.active
	defer func() {
		if !wasActive {
			return
		}
		if f, ok := result.(*port.HelperRecoveryFailure); ok && f != nil && f.Uncertain {
			r.unknown = errors.Join(r.unknown, result)
			r.config.RetainUnknown(result)
		}
	}()
	if !r.active {
		return fail("runtime_closed", true, r.unknown != nil, r.unknown)
	}
	if effect != "" {
		if r.attempts[effect] {
			return fail("recovery_attempt_unknown", false, true, r.unknown)
		}
		r.attempts[effect] = true
		if r.unknown != nil {
			return fail("recovery_attempt_unknown", false, true, r.unknown)
		}
	}
	if err := r.deadline(ctx, false); err != nil {
		return err
	}
	until := r.until
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(until) {
		until = earlier
	}
	base, cancel := context.WithDeadline(ctx, until)
	// This callback only propagates cancellation. It performs no native work or
	// cleanup; resource ownership still joins fn synchronously below.
	stop := context.AfterFunc(r.original, cancel)
	defer func() { stop(); cancel() }()
	effective := nativeContext{Context: base, original: r.original, until: until}
	err := fn(effective)
	late := r.deadline(effective, effect != "")
	err = r.classify(err, effect != "")
	if late != nil {
		if err == nil {
			err = late
		} else if f, ok := err.(*port.HelperRecoveryFailure); ok && f != nil {
			v := *f
			v.Uncertain = v.Uncertain || effect != ""
			v.Cause = errors.Join(v.Cause, late)
			err = &v
		}
	}
	if err != nil {
		r.view = nil
	}
	return err
}

func (r *runtime) classify(err error, effected bool) error {
	if err == nil {
		return nil
	}
	if f, ok := err.(*port.HelperRecoveryFailure); ok && f != nil {
		if !boundedCode(f.Code) || f.Phase != "refused" {
			return fail("internal", true, effected || f.Uncertain, err)
		}
		copy := *f
		copy.Cause = err
		return &copy
	}
	if err == context.Canceled || err == context.DeadlineExceeded {
		return fail("canceled", false, effected, err)
	}
	if f, ok := err.(*installmove.Failure); ok && f != nil {
		if !boundedCode(f.Code) {
			return fail("internal", true, effected || f.Uncertain, err)
		}
		return fail(f.Code, f.Internal, f.Uncertain, err)
	}
	if f, ok := err.(*helperroutes.Error); ok && f != nil {
		if f.Internal {
			return fail("internal", true, effected, err)
		}
		switch f.Code {
		case helperroutes.CodeContext:
			return fail("canceled", false, effected, err)
		case helperroutes.CodeMissing, helperroutes.CodeType, helperroutes.CodeOwner, helperroutes.CodeMode, helperroutes.CodeChanged:
			return fail("route_changed", false, false, err)
		}
	}
	switch err {
	case records.BindingMismatch:
		return fail("journal_mismatch", false, false, err)
	case records.Invalid, records.Oversized, records.EncodingInvalid:
		return fail("journal_invalid", false, false, err)
	}
	// An opaque wrapper/join never inherits a nested refusal classification.
	return fail("internal", true, effected, err)
}

func boundedCode(code string) bool {
	if len(code) == 0 || len(code) > 80 || code[0] < 'a' || code[0] > 'z' {
		return false
	}
	for _, c := range code[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

func (r *runtime) fence(ctx context.Context) error {
	if r.unknown != nil {
		return fail("recovery_attempt_unknown", false, true, r.unknown)
	}
	if err := r.config.Unknown(); err != nil {
		return fail("recovery_attempt_unknown", false, true, err)
	}
	if err := r.routes(ctx); err != nil {
		return err
	}
	if err := r.config.Reverify(ctx, copyRequest(r.config.Request)); err != nil {
		return err
	}
	if err := r.routes(ctx); err != nil {
		return err
	}
	if err := r.config.Unknown(); err != nil {
		return fail("recovery_attempt_unknown", false, true, err)
	}
	return r.deadline(ctx, false)
}

func (r *runtime) Fence(ctx context.Context) error {
	return r.invoke(ctx, "", func(c context.Context) error { return r.fence(c) })
}

func (r *runtime) ReadPhase(ctx context.Context) (string, error) {
	var phase string
	err := r.invoke(ctx, "", func(c context.Context) error {
		if err := r.fence(c); err != nil {
			return err
		}
		view, err := r.reader.ReadHelper(c)
		if err != nil {
			return err
		}
		if view == nil || view.Value == nil {
			return fail("journal_invalid", false, false, nil)
		}
		if view.Value.Operation != operation(r.config.Request) {
			return fail("journal_mismatch", false, false, nil)
		}
		// Copy values rather than retaining an adapter-owned projection alias.
		v, value := *view, *view.Value
		v.Value = &value
		r.view, phase = &v, value.Phase
		return r.fence(c)
	})
	if err != nil {
		return "", err
	}
	return phase, nil
}

func (r *runtime) WritePhase(ctx context.Context, phase string) error {
	return r.invoke(ctx, "journal:"+phase, func(c context.Context) error {
		if r.view == nil || r.view.Value == nil {
			return fail("journal_mismatch", false, false, nil)
		}
		if err := r.fence(c); err != nil {
			return err
		}
		return r.persistJournal(c, r.view.Revision, phase)
	})
}

func (r *runtime) persistJournal(ctx context.Context, revision, phase string) error {
	value := release.Journal{Operation: operation(r.config.Request), Phase: phase}
	if _, err := records.EncodeJournal(records.Journal{Schema: "farol.installed-update-journal/1", Operation: records.Operation{
		ID:     value.Operation.ID,
		Source: records.Build{Digest: value.Operation.Source.Digest, Version: value.Operation.Source.Version, BuildID: value.Operation.Source.BuildID},
		Target: records.Build{Digest: value.Operation.Target.Digest, Version: value.Operation.Target.Version, BuildID: value.Operation.Target.BuildID},
	}, Phase: phase}); err != nil {
		return fail("journal_invalid", false, false, err)
	}
	view, err := r.config.Journal.CompareAndSwap(ctx, revision, value)
	if err != nil {
		return fail("internal", true, true, err)
	}
	r.effected = true
	if view == nil || view.Value == nil || *view.Value != value {
		return fail("internal", true, true, nil)
	}
	v, owned := *view, *view.Value
	v.Value, r.view = &owned, &v
	return r.persistedFence(ctx)
}

// A successful persistence acknowledgement cannot become a known no-effect
// refusal merely because the subsequent owner/route fence refuses.
func (r *runtime) persistedFence(ctx context.Context) error {
	if err := r.classify(r.fence(ctx), true); err != nil {
		f := err.(*port.HelperRecoveryFailure) // classify's closed nonnil result.
		f.Uncertain = true
		return f
	}
	return nil
}

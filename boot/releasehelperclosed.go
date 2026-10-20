package boot

import (
	"context"
	"errors"
	"os"
	"reflect"
	"runtime"
	"sync"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	"github.com/legrch/farol/modules/release/app/services/processwait"
	"github.com/legrch/farol/modules/release/infra/native/handoff"
	"github.com/legrch/farol/modules/release/infra/native/helperchannels"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	"github.com/legrch/farol/modules/release/infra/native/helperlocks"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"github.com/legrch/farol/modules/release/infra/native/processprobe"
	"github.com/legrch/farol/modules/release/infra/native/slotbinding"
	"golang.org/x/sys/unix"
)

// closedHelperFiles is an explicit trusted-launch ABI, not descriptor discovery
// or peer authentication. Transport descriptions must be unique, with no dup or
// os.File aliases. Ownership of request/ACK/continuation transfers ON CALL,
// including failure. Lease is the caller's already exclusively locked fd5: the
// caller keeps it and its aliases unchanged through actual synchronous return.
// This unselected composition never adopts, duplicates or closes it. Its only
// change is adding FD_CLOEXEC to fd5's per-process descriptor flag before any
// request IO (see takeClosedHelperFiles), so a later exec'd child cannot inherit
// the lease.
type closedHelperFiles struct{ Request, ACK, Lease, Continuation *os.File }

type closedHelperFailure struct {
	uncertain bool
	cause     error
}

func (e *closedHelperFailure) Error() string { return "release_closed_helper_refused_or_unknown" }
func (e *closedHelperFailure) Unwrap() error { return e.cause }

// Do not downgrade a wrapped/joined native or callback failure to a refusal.
// All causes remain private; oversize/cyclic provenance is conservatively unknown.
func closedHelperFail(uncertain bool, causes ...error) error {
	pending := append([]error(nil), causes...)
	for remaining := 128; len(pending) > 0; remaining-- {
		if remaining == 0 {
			uncertain = true
			break
		}
		e := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if e == nil {
			continue
		}
		value := reflect.ValueOf(e)
		switch value.Kind() {
		case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
			if value.IsNil() {
				uncertain = true
				continue
			}
		}
		switch f := e.(type) {
		case *closedHelperFailure:
			uncertain = uncertain || f.uncertain
		case *closedHelperRefused, *closedHelperRefusalRecord:
			// A refusal is only meaningful standing alone. Beside any other cause it
			// is part of an unknown outcome.
			uncertain = true
		case *helperchannels.Failure:
			uncertain = uncertain || f.Uncertain || f.CleanupUnconfirmed
		case *helperlocks.Failure:
			uncertain = uncertain || f.Uncertain || f.Internal
		case *handoff.Failure:
			uncertain = uncertain || f.Uncertain || f.Internal
		case *helperroutes.Error:
			uncertain = uncertain || f.Internal
		case *slotbinding.VerificationFailure:
			uncertain = uncertain || f.Internal
		case *releaseport.ProcessProbeFailure:
			uncertain = uncertain || f.Kind != releaseport.ProcessProbeUnknown && f.Kind != releaseport.ProcessProbeInput
		case *releaseport.HelperRecoveryFailure:
			uncertain = uncertain || f.Uncertain || f.Internal
		case *executionapp.Failure:
			uncertain = uncertain || f.Uncertain || f.Internal
		case *processwait.Failure:
			// Live-predecessor observation only; the closed path never produces it.
			uncertain = uncertain || f.Uncertain
		case *inputapp.Failure, *protocolapp.Failure, handoff.Code:
		case interface{ Unwrap() []error }, interface{ Unwrap() error }:
			// An opaque wrapper may conceal a native failure beside a refusal.
			uncertain = true
		default:
			if e != context.Canceled && e != context.DeadlineExceeded {
				uncertain = true
			}
		}
		switch f := e.(type) {
		case interface{ Unwrap() []error }:
			children := f.Unwrap()
			if len(children) > remaining {
				uncertain = true
				continue
			}
			pending = append(pending, children...)
		case interface{ Unwrap() error }:
			pending = append(pending, f.Unwrap())
		}
	}
	return &closedHelperFailure{uncertain: uncertain, cause: errors.Join(causes...)}
}

func closedHelperJoin(uncertain bool, causes ...error) error {
	var only error
	count := 0
	for _, e := range causes {
		if e != nil {
			only = e
			count++
		}
	}
	if count == 0 {
		return nil
	}
	// A sent refused frame passes unchanged through custody cleanup that itself
	// succeeded. Any other cause beside it makes the outcome unknown.
	if r, ok := only.(*closedHelperRefused); ok && r != nil && count == 1 {
		return r
	}
	return closedHelperFail(uncertain, causes...)
}

// The fixed absolute boundary is enforced even when a parent's timer/Err lags.
// A later context can shorten the budget, never replace original cancellation.
type closedHelperContext struct {
	context.Context
	original context.Context
	until    time.Time
}

func (c closedHelperContext) Err() error {
	if e := c.original.Err(); e != nil {
		return e
	}
	if e := c.Context.Err(); e != nil {
		return e
	}
	if !time.Now().Before(c.until) {
		return context.DeadlineExceeded
	}
	return nil
}
func closedHelperBounds(ctx context.Context, until time.Time) error {
	if ctx == nil || until.IsZero() {
		return closedHelperFail(false)
	}
	var late error
	if !time.Now().Before(until) {
		late = context.DeadlineExceeded
	}
	if d, ok := ctx.Deadline(); ok && !time.Now().Before(d) {
		late = context.DeadlineExceeded
	}
	return closedHelperJoin(false, ctx.Err(), context.Cause(ctx), late)
}
func closedHelperEffective(ctx, original context.Context, until time.Time) (context.Context, context.CancelFunc) {
	base, cancel := context.WithDeadline(ctx, until)
	stop := context.AfterFunc(original, cancel)
	bound, _ := base.Deadline()
	return closedHelperContext{base, original, bound}, func() { stop(); cancel() }
}

type closedHelperInput interface {
	Read(context.Context, time.Time) ([]byte, error)
	Close() error
}
type closedHelperChannels interface {
	Emit(context.Context, time.Time, []byte) error
	AwaitContinue(context.Context, time.Time) ([]byte, error)
	Close() error
}
type closedHelperRoutes interface {
	WithFiles(context.Context, func(helperroutes.Files) error) error
	Close() error
}
type closedHelperAdmission interface {
	Check(context.Context) error
	AcquireUpdate(context.Context) error
	Close() error
}

// Private deterministic seams. The only production entry below supplies fixed
// concrete native owners. No caller can supply an allowed bool or authenticator.
type closedHelperDependencies struct {
	take      func(closedHelperFiles) (closedHelperInput, closedHelperChannels, error)
	borrow    func(*os.File, func() error) error
	open      func(context.Context, releaseport.HelperRequest, time.Time) (closedHelperRoutes, error)
	admission func(helperroutes.Files, *os.File, releaseport.HelperRequest, []byte, time.Time) (closedHelperAdmission, error)
	// ready completes pre-ACK application readiness inside the borrowed routes.
	// The helper wraps ONLY the preflight scope (observation-only); it ends before
	// the ready frame and is never the post-continuation callback scope.
	ready func(context.Context, *executionapp.Milestone, closedReleaseHelper) (*executionapp.Readiness, error)
	// execute composes the single post-continuation Milestone.Execute under the
	// callback scope's own custody. Only closedReleaseHelper.execute reaches it.
	execute closedHelperExecutor
}

// withClosedReleaseHelper composes closed custody, pre-ACK application readiness
// and protocol. It selects no CLI and executes no journal, installation,
// recovery or relaunch operation: readiness is observation-only and its result is
// merely retained for a later, separately selected execution step. The ready
// frame is emitted only after custody AND readiness; it is not terminal evidence.
// The trusted launch must supply its original absolute bound, captured before
// request work; request WaitSeconds and later contexts never start a fresh budget.
func withClosedReleaseHelper(ctx context.Context, files closedHelperFiles, until time.Time, fn func(closedReleaseHelper) error) error {
	return withClosedReleaseHelperDependencies(ctx, files, until, fn, closedHelperProductionDependencies())
}

// closedHelperProductionDependencies is the fixed concrete composition. It is a
// function only so the explicit native test lane can reuse it with one seam replaced.
func closedHelperProductionDependencies() closedHelperDependencies {
	return closedHelperDependencies{
		take: takeClosedHelperFiles, borrow: borrowClosedHelperLease,
		open: func(ctx context.Context, r releaseport.HelperRequest, u time.Time) (closedHelperRoutes, error) {
			if runtime.GOOS != "darwin" {
				return nil, closedHelperFail(false)
			}
			return helperroutes.OpenExisting(ctx, r.Home, r.OperationID, *r.InstallLocation, u)
		},
		admission: newClosedHelperAdmission,
		ready:     closedHelperReady,
		execute:   closedHelperExecute,
	}
}

func withClosedReleaseHelperDependencies(ctx context.Context, files closedHelperFiles, until time.Time, fn func(closedReleaseHelper) error, deps closedHelperDependencies) (result error) {
	// Capture before constructors, request IO, route opening or protocol work.
	if ctx != nil {
		if d, ok := ctx.Deadline(); ok && d.Before(until) {
			until = d
		}
	}
	input, channels, takeErr := deps.take(files)
	exposed := false
	var scoped *closedReleaseHelperState
	defer func() {
		if p := recover(); p != nil {
			result = closedHelperJoin(true, result, closedHelperPanic(p))
		}
		if channels != nil {
			result = closedHelperJoin(exposed, result, channels.Close())
		}
		if input != nil {
			result = closedHelperJoin(exposed, result, input.Close())
		}
		result = closedHelperJoin(exposed, result, closedHelperBounds(ctx, until))
		if scoped != nil && result != nil {
			scoped.retainUnknown(result)
		}
	}()
	if takeErr != nil {
		return closedHelperFail(false, takeErr)
	}
	if fn == nil || input == nil || channels == nil {
		return closedHelperFail(false)
	}
	if err := closedHelperBounds(ctx, until); err != nil {
		return err
	}
	effective, cancel := closedHelperEffective(ctx, ctx, until)
	defer cancel()
	data, err := input.Read(effective, until)
	if err != nil {
		return closedHelperFail(false, err)
	}
	protocol, err := protocolapp.Bind(effective, data, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		return closedHelperFail(false, err)
	}
	request, err := protocol.Request(effective)
	if err != nil {
		return closedHelperFail(false, err)
	}
	// This prepared subset requires a physical slot proof, including explicit
	// legacy location. The old optional-location branch is deliberately unsupported.
	// Relaunch is deliberately unselected: its gate is CLOSED. It is refused here,
	// before any IO or frame, so no later step can reach a launch effect.
	if request.Predecessor == nil || request.LeaseIdentity == nil || request.InstallLocation == nil || request.Predecessor.Kind != "confirmed_closed" || request.Action != "apply" && request.Action != "rollback" || request.Relaunch {
		return closedHelperFail(false)
	}
	if err := closedHelperBounds(effective, until); err != nil {
		return err
	}
	// From here the request is known: a provably clean pre-ACK refusal is sent as
	// the one refused frame (see closedHelperRefusalPath) instead of staying silent.
	refusal := &closedHelperRefusalPath{ctx: effective, until: until, protocol: protocol, operationID: request.OperationID, emit: channels.Emit, exposed: &exposed}
	milestone, err := executionapp.NewMilestone(effective, request)
	if err != nil {
		return refusal.refuse(err)
	}
	if milestone == nil {
		return closedHelperFail(false)
	}
	expected, err := protocol.BuildSlotBinding(effective, protocolnative.JSONCodec{})
	if err != nil {
		return refusal.refuse(err)
	}
	if len(expected) == 0 {
		return closedHelperFail(false)
	}
	return refusal.finish(deps.borrow(files.Lease, func() (err error) {
		routes, err := deps.open(effective, request, until)
		if err != nil {
			return refusal.refuse(err)
		}
		if routes == nil {
			return closedHelperFail(true)
		}
		routesClosed := false
		closeRoutes := func() error {
			if routesClosed {
				return nil
			}
			routesClosed = true
			return routes.Close()
		}
		defer func() { err = closedHelperJoin(exposed, err, closeRoutes()) }()
		return refusal.beforeCallback(routes.WithFiles(effective, refusal.settle(func(borrow helperroutes.Files) (err error) {
			admission, err := deps.admission(borrow, files.Lease, request, expected, until)
			if err != nil {
				return refusal.refuse(err)
			}
			if admission == nil {
				return closedHelperFail(true)
			}
			defer func() { err = closedHelperJoin(exposed, err, admission.Close()) }()
			check := func() error {
				checked, bounded := admission.Check(effective), closedHelperBounds(effective, until)
				if checked != nil && bounded == nil && !exposed {
					return refusal.refuse(checked)
				}
				return closedHelperJoin(exposed, checked, bounded)
			}
			if err = check(); err != nil {
				return err
			}
			// Application readiness follows the first custody proof and precedes the
			// frame. A provably clean refusal here sends the one refused frame; any
			// other failure exposes nothing and is unknown.
			preflight := &closedReleaseHelperState{active: true, files: borrow, request: closedHelperRequestCopy(request), original: effective, until: until, admission: admission}
			var readiness *executionapp.Readiness
			err = closedHelperCall(func() (e error) {
				if deps.ready == nil {
					return closedHelperFail(true)
				}
				readiness, e = deps.ready(effective, milestone, closedReleaseHelper{preflight})
				return e
			})
			// Join every entered preflight call before judging the result.
			preflight.end()
			// Uncertainty retained before this judgement is sticky: it forbids a
			// refusal even when the final error is itself a clean classification.
			prior := preflight.unknown()
			if err != nil {
				preflight.retainUnknown(err)
				if prior == nil {
					return refusal.refuse(err)
				}
				return closedHelperFail(false, err)
			}
			if err = preflight.unknown(); err != nil {
				return closedHelperFail(false, err)
			}
			if readiness == nil {
				// A seam that reports success without a result is an internal defect,
				// retained as unknown exactly like an error or panic.
				err = closedHelperFail(true)
				preflight.retainUnknown(err)
				return err
			}
			frame, err := protocol.BuildHandoff(effective, protocolapp.ClosedPredecessorReady, nil)
			if err != nil {
				return closedHelperFail(false, err)
			}
			// Fence after readiness, immediately before the only ACK attempt.
			if err = check(); err != nil {
				return err
			}
			// There is one actual attempt: from here a failure is unknown and no refused
			// frame follows the ready frame. Before this point a clean refusal sent the
			// one refused frame instead (refusal.refuse); neither path retries or receipts.
			exposed = true
			if err = channels.Emit(effective, until, frame); err != nil {
				return closedHelperFail(true, err)
			}
			if err = check(); err != nil {
				return err
			}
			continuation, err := channels.AwaitContinue(effective, until)
			if err != nil {
				return closedHelperFail(true, err)
			}
			if err = protocol.ValidateContinuation(effective, continuation); err != nil {
				return closedHelperFail(true, err)
			}
			if err = check(); err != nil {
				return err
			}
			// Preserve CLOSED sequencing: update_lock happens AFTER continuation and
			// closed/inherited recheck, never while waiting for the parent's release.
			if err = admission.AcquireUpdate(effective); err != nil {
				return closedHelperFail(true, err)
			}
			if err = check(); err != nil {
				return err
			}
			state := &closedReleaseHelperState{active: true, files: borrow, request: closedHelperRequestCopy(request), original: effective, until: until, admission: admission, milestone: milestone, readiness: readiness, execution: deps.execute, updateHeld: true}
			scoped = state
			defer func() {
				// Joins every already-entered scoped callback/native method before cleanup,
				// even after cancellation or a callback panic. No descriptor closure detaches.
				state.end()
				err = closedHelperJoin(true, err, state.unknown())
			}()
			err = closedHelperCall(func() error { return fn(closedReleaseHelper{state}) })
			if err != nil {
				state.retainUnknown(err)
			}
			state.end()
			if err != nil {
				return closedHelperFail(true, err)
			}
			if err = state.unknown(); err != nil {
				return err
			}
			if err = check(); err != nil {
				state.retainUnknown(err)
				return err
			}
			return nil
		})), closeRoutes)
	}))
}

func closedHelperRequestCopy(r releaseport.HelperRequest) releaseport.HelperRequest {
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

type closedHelperPanicked struct{ value any }

func (p *closedHelperPanicked) Error() string { return "release_closed_helper_callback_panicked" }
func (p *closedHelperPanicked) Unwrap() error { e, _ := p.value.(error); return e }
func closedHelperPanic(p any) error           { return &closedHelperPanicked{value: p} }
func closedHelperCall(fn func() error) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = closedHelperFail(true, closedHelperPanic(p))
		}
	}()
	return fn()
}

// Copies share one scope, one nested borrow attempt and sticky unknown state.
// The only files exposure is a synchronous callback, for later trusted existing
// journal/execution composition. Retaining a wrapper cannot renew this scope.
type closedReleaseHelper struct{ state *closedReleaseHelperState }
type closedReleaseHelperState struct {
	mu           sync.Mutex
	native       sync.Mutex
	active, used bool
	calls        sync.WaitGroup
	files        helperroutes.Files
	request      releaseport.HelperRequest
	original     context.Context
	until        time.Time
	admission    closedHelperAdmission
	retained     error
	// Retained for the single execution step. Only closedReleaseHelper.execute
	// consumes them, once. relaunch is set by the live helper alone.
	milestone *executionapp.Milestone
	readiness *executionapp.Readiness
	execution closedHelperExecutor
	relaunch  *closedHelperRelaunch
	// updateHeld is set only at construction of the post-AcquireUpdate callback
	// scope, after AcquireUpdate returned success and the next custody check
	// passed. The preflight scope never sets it. closedHelperNativeAdmission.Check
	// verifies the update lease only when one exists, so it cannot prove this.
	updateHeld bool
}

func (s *closedReleaseHelperState) begin(consume bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active || s.retained != nil || consume && s.used {
		return closedHelperFail(s.retained != nil, s.retained)
	}
	if consume {
		s.used = true
	}
	s.calls.Add(1)
	return nil
}
func (s *closedReleaseHelperState) retainUnknown(e error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e == nil {
		e = closedHelperFail(true)
	}
	s.retained = closedHelperJoin(true, s.retained, e)
}
func (s *closedReleaseHelperState) unknown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.retained
}
func (s *closedReleaseHelperState) end() {
	s.mu.Lock()
	s.active = false
	s.mu.Unlock()
	s.calls.Wait()
}
func (s closedReleaseHelper) unknown() error {
	if s.state == nil {
		return closedHelperFail(true)
	}
	return s.state.unknown()
}
func (s closedReleaseHelper) retainUnknown(e error) {
	if s.state != nil {
		s.state.retainUnknown(e)
	}
}

// reverify matches the COMPLETE original request, then observes the same actual
// native owners. It is suitable for the existing runtime's Reverify port, not a
// caller assertion. Any failed fence permanently closes this owner's authority.
func (s closedReleaseHelper) reverify(ctx context.Context, r releaseport.HelperRequest) (err error) {
	if s.state == nil {
		return closedHelperFail(false)
	}
	o := s.state
	if err = o.begin(false); err != nil {
		return err
	}
	defer o.calls.Done()
	o.native.Lock()
	defer o.native.Unlock()
	defer func() {
		if err != nil {
			o.retainUnknown(err)
		}
	}()
	if err = o.unknown(); err != nil {
		return err
	}
	if ctx == nil || !reflect.DeepEqual(r, o.request) {
		return closedHelperFail(false)
	}
	effective, cancel := closedHelperEffective(ctx, o.original, o.until)
	defer cancel()
	if err = closedHelperBounds(effective, o.until); err != nil {
		return err
	}
	return closedHelperJoin(false, o.admission.Check(effective), closedHelperBounds(effective, o.until))
}

func (s closedReleaseHelper) withFiles(ctx context.Context, fn func(context.Context, helperroutes.Files, releaseport.HelperRequest, time.Time) error) (err error) {
	if s.state == nil {
		return closedHelperFail(false)
	}
	o := s.state
	if err = o.begin(true); err != nil {
		return err
	}
	defer o.calls.Done()
	defer func() {
		if err != nil {
			o.retainUnknown(err)
		}
	}()
	if fn == nil || ctx == nil {
		return closedHelperFail(false)
	}
	if err = s.reverify(ctx, o.request); err != nil {
		return err
	}
	effective, cancel := closedHelperEffective(ctx, o.original, o.until)
	defer cancel()
	err = closedHelperCall(func() error { return fn(effective, o.files, closedHelperRequestCopy(o.request), o.until) })
	if err != nil {
		return closedHelperFail(true, err)
	}
	return s.reverify(ctx, o.request)
}

// Explicit roles are checked only on the supplied real File owners. Native
// metadata cannot prove uniqueness of dup aliases or trusted peer provenance.
type closedHelperFileRole struct {
	file      *os.File
	number    int
	stat      unix.Stat_t
	inspected bool
}

func inspectClosedHelperRole(file *os.File, want int) (role closedHelperFileRole, err error) {
	role.file = file
	role.number = -1
	if file == nil {
		return role, closedHelperFail(false)
	}
	raw, e := file.SyscallConn()
	if e != nil {
		return role, closedHelperFail(true, e)
	}
	var inner error
	e = raw.Control(func(fd uintptr) {
		role.number = int(fd)
		inner = unix.Fstat(int(fd), &role.stat)
		role.inspected = inner == nil
		if int(fd) != want {
			inner = closedHelperJoin(false, inner, closedHelperFail(false))
		}
	})
	return role, closedHelperJoin(false, e, inner)
}

// closedHelperLeaseCloseOnExec adds FD_CLOEXEC to the borrowed fd5 only. Go's
// exec dup2s only Stdio and ExtraFiles, so a non-CLOEXEC lease would leak into
// every child (/bin/ps, a relaunch). The flag belongs to this process's
// descriptor table entry, so the parent's table and the shared open-file
// description (offset, status flags, flock) stay untouched.
func closedHelperLeaseCloseOnExec(lease *os.File) error {
	if lease == nil {
		return closedHelperFail(false)
	}
	raw, err := lease.SyscallConn()
	if err != nil {
		return closedHelperFail(true, err)
	}
	var inner error
	err = raw.Control(func(fd uintptr) {
		if fd != 5 {
			inner = closedHelperFail(false)
			return
		}
		if e := closedHelperSetCloseOnExec(fd); e != nil {
			inner = closedHelperFail(false, e)
		}
	})
	return closedHelperJoin(false, err, inner)
}

// closedHelperSetCloseOnExec reads F_GETFD and ORs in FD_CLOEXEC; nothing else.
func closedHelperSetCloseOnExec(fd uintptr) error {
	flags, err := unix.FcntlInt(fd, unix.F_GETFD, 0)
	if err != nil {
		return err
	}
	if flags&unix.FD_CLOEXEC != 0 {
		return nil
	}
	_, err = unix.FcntlInt(fd, unix.F_SETFD, flags|unix.FD_CLOEXEC)
	return err
}

func borrowClosedHelperLease(lease *os.File, fn func() error) error {
	if lease == nil {
		return closedHelperFail(false)
	}
	raw, err := lease.SyscallConn()
	if err != nil {
		return closedHelperFail(true, err)
	}
	// RawConn.Control pins this exact descriptor only through its synchronous
	// callback (Go syscall.RawConn). Keep the original bounded scope, including
	// entered observer Join and cleanup, inside it; never retain fd afterward.
	var result error
	err = raw.Control(func(fd uintptr) {
		if fd != 5 {
			result = closedHelperFail(false)
			return
		}
		// takeClosedHelperFiles already added FD_CLOEXEC before any request IO.
		// Borrow only re-observes it; a cleared flag refuses before fn or any effect.
		flags, e := unix.FcntlInt(fd, unix.F_GETFD, 0)
		if e != nil || flags&unix.FD_CLOEXEC == 0 {
			result = closedHelperFail(false, e)
			return
		}
		result = fn()
	})
	return closedHelperJoin(false, result, err)
}
func takeClosedHelperFiles(f closedHelperFiles) (closedHelperInput, closedHelperChannels, error) {
	lease, leaseErr := inspectClosedHelperRole(f.Lease, 5)
	if leaseErr == nil {
		// Before any request IO: a flag failure refuses while the one-shot request
		// is still unread, and the transports below are closed by the same path.
		leaseErr = closedHelperLeaseCloseOnExec(f.Lease)
	}
	result := closedHelperJoin(false, leaseErr)
	seen := map[*os.File]bool{f.Lease: true}
	transports := []*os.File{f.Request, f.ACK, f.Continuation}
	wants := []int{3, 4, 6}
	var consumed []closedHelperFileRole
	for i, file := range transports {
		if file == nil || seen[file] {
			result = closedHelperJoin(false, result, closedHelperFail(false))
			continue
		}
		seen[file] = true
		role, err := inspectClosedHelperRole(file, wants[i])
		result = closedHelperJoin(false, result, err)
		// Never transfer the borrowed role or a demonstrable alias, even in a
		// malformed trusted-launch call. No metadata check can prove dup uniqueness.
		alias := role.inspected && lease.inspected && role.stat.Dev == lease.stat.Dev && role.stat.Ino == lease.stat.Ino && role.stat.Mode&unix.S_IFMT == lease.stat.Mode&unix.S_IFMT
		if role.number == 5 || alias {
			result = closedHelperJoin(false, result, closedHelperFail(true))
			continue
		}
		consumed = append(consumed, role)
		if !role.inspected || role.stat.Mode&unix.S_IFMT != unix.S_IFIFO && role.stat.Mode&unix.S_IFMT != unix.S_IFSOCK {
			result = closedHelperJoin(false, result, closedHelperFail(false))
		}
	}
	if result != nil {
		for _, role := range consumed {
			// Exact supplied File ownership, never integer reconstruction or detached
			// Close. Stream constructors also disable owned socket linger on failure.
			owner, err := helperchannels.TakeRequest(role.file)
			result = closedHelperJoin(false, result, err)
			if owner != nil {
				result = closedHelperJoin(false, result, owner.Close())
			}
		}
		return nil, nil, result
	}
	input, err := helperchannels.TakeRequest(f.Request)
	channels, other := helperchannels.Take(f.ACK, f.Continuation)
	return input, channels, closedHelperJoin(false, err, other)
}

type closedHelperNativeAdmission struct {
	files     helperroutes.Files
	until     time.Time
	inherited *handoff.Verifier
	slot      *slotbinding.Verifier
	update    *helperlocks.Lease
	probeJoin func() error // Original observer only; no replacement observation.
}
type closedHelperProcess struct {
	probe *processprobe.Probe
	pid   int
	start string
	until time.Time
}

func (p closedHelperProcess) Observe(ctx context.Context, pid int, start string) (handoff.ProcessState, error) {
	if p.probe == nil || pid != p.pid || start != p.start || p.probe.PID() != pid {
		return handoff.ProcessUnknown, closedHelperFail(false)
	}
	observation, err := p.probe.Observe(ctx, p.until)
	return closedHelperProcessResult(observation, err)
}

func closedHelperProcessResult(observation releaseport.ProcessObservation, err error) (handoff.ProcessState, error) {
	if err != nil {
		return handoff.ProcessUnknown, err
	}
	switch observation.Presence {
	case releaseport.ProcessAbsent:
		if observation.Start == "" {
			return handoff.ProcessAbsent, nil
		}
	case releaseport.ProcessPresent:
		// A reused PID remains present and refuses, irrespective of its birth token.
		if observation.Start != "" {
			return handoff.ProcessPresent, nil
		}
	}
	return handoff.ProcessUnknown, closedHelperFail(true)
}
func newClosedHelperAdmission(files helperroutes.Files, lease *os.File, r releaseport.HelperRequest, expected []byte, until time.Time) (closedHelperAdmission, error) {
	probe, err := processprobe.New(int(r.PID))
	if err != nil {
		return nil, err
	}
	slot, err := slotbinding.NewVerifier(files.Operation, slotbinding.Identity(files.OperationIdentity), expected, until)
	if err != nil {
		return nil, err
	}
	p := r.Predecessor
	verifier, err := handoff.New(r.Home, files.Home, files.State, lease, handoff.Expected{
		StateIdentity: handoff.Identity(p.StateIdentity), LeaseIdentity: handoff.Identity(*r.LeaseIdentity), PID: int(r.PID), ProcessStart: r.ProcessStart, StartedAt: p.StartedAt, LastQuitSHA256: p.LastQuitSHA256,
	}, closedHelperProcess{probe, int(r.PID), r.ProcessStart, until}, time.Now)
	if err != nil {
		return nil, err
	}
	return &closedHelperNativeAdmission{files: files, until: until, inherited: verifier, slot: slot, probeJoin: probe.Join}, nil
}
func (a *closedHelperNativeAdmission) Check(ctx context.Context) error {
	if err := a.files.Reverify(ctx); err != nil {
		return err
	}
	if err := a.inherited.VerifyClosed(ctx); err != nil {
		return err
	}
	if err := a.slot.Verify(ctx); err != nil {
		return err
	}
	if a.update != nil {
		return a.update.Verify(ctx)
	}
	return closedHelperBounds(ctx, a.until)
}
func (a *closedHelperNativeAdmission) AcquireUpdate(ctx context.Context) error {
	if a.update != nil {
		return closedHelperFail(false)
	}
	lease, err := helperlocks.AcquireUpdate(ctx, helperlocks.Directory{File: a.files.Update, Identity: helperlocks.Identity(a.files.UpdateIdentity)}, a.until)
	a.update = lease
	return err
}
func (a *closedHelperNativeAdmission) Close() error {
	var closeUpdate func() error
	if a.update != nil {
		closeUpdate = a.update.Close
	}
	return closeClosedHelperOwners(a.probeJoin, closeUpdate)
}

// Join observes the original native return even after its bounded result failed.
// Only then may the scope release its update owner and borrowed route lifetime.
// A failed Join remains a cause and never becomes a successful observation.
func closeClosedHelperOwners(join, closeUpdate func() error) error {
	var joined, closed error
	if join != nil {
		joined = join()
	}
	if closeUpdate != nil {
		closed = closeUpdate()
	}
	return closedHelperJoin(false, joined, closed)
}

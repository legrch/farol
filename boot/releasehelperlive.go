package boot

import (
	"context"
	"os"
	"runtime"
	"sync/atomic"
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

// The live release helper composes the LIVE-predecessor apply and rollback
// path of resources/native/update_helper.py (run(), the non-closed branches) over
// the existing Go owners. The desktop selects it (`run-live-release-helper`)
// whenever no promotion lease is transferred. It accepts apply and rollback, each
// with or without relaunch, and recover with relaunch only (offline recover
// refuses before any IO). Requested relaunch follows verified target installation
// or restoration of the source as rolled_back (Milestone.Execute). Cancelled
// recovery stays closed. Recover alone attaches the boot-adapted recovery policy owner
// (releasehelperrecovery.go) to its Milestone. The closed composition
// (releasehelperclosed*.go) still refuses relaunch and recover; the scope state,
// readiness, execution and terminal classification are the same owners it uses.
//
// Order, mirroring Python (apply 1258-1265, rollback 1331-1348):
//
//	parse -> validate -> routes -> custody check -> update lock -> original
//	running marker -> pre-ACK readiness -> predecessor identity -> waiting_for_exit
//	-> wait for that exact process to exit -> promotion lease + diagnostic Quit observation ->
//	custody check -> callback scope (Execute once).
//
// There is no continuation channel and no inherited lease: fd3 is the request
// and fd4 the ACK, exactly the live launch layout of installed-update-helper.ts.
type liveHelperFiles struct{ Request, ACK *os.File }

const (
	liveHelperRequestFD = 3
	liveHelperACKFD     = 4
)

// liveHelperChannels is the ACK-only transport; there is no continuation.
type liveHelperChannels interface {
	Emit(context.Context, time.Time, []byte) error
	Close() error
}

// liveHelperAdmission is the closed custody interface plus the live-only phases.
// Each phase is one attempt; Check proves custody for the phase reached so far.
type liveHelperAdmission interface {
	closedHelperAdmission
	// Capture reads the original running marker once (Python initial_marker).
	Capture(context.Context) error
	// Confirm positively identifies the original process (Python process_start).
	Confirm(context.Context) error
	// Wait observes that exact process exit within the original bound.
	Wait(context.Context, time.Time) error
	// Quit acquires the promotion lease after observed exit. Drain status is
	// diagnostic only; it does not prevent application bundle replacement.
	Quit(context.Context) error
}

type liveHelperDependencies struct {
	take      func(liveHelperFiles) (closedHelperInput, liveHelperChannels, error)
	open      func(context.Context, releaseport.HelperRequest, time.Time) (closedHelperRoutes, error)
	admission func(helperroutes.Files, releaseport.HelperRequest, []byte, time.Time) (liveHelperAdmission, error)
	ready     func(context.Context, *executionapp.Milestone, closedReleaseHelper) (*executionapp.Readiness, error)
	execute   closedHelperExecutor
	// measure observes this very process for the relaunch hint (Python
	// process_start of os.getpid()). It is consulted only through a request that
	// asked for relaunch.
	measure func(context.Context, time.Time) (releaseport.HelperSelfIdentity, error)
	// now supplies the wait budget's start; production uses time.Now.
	now func() time.Time
	// recovery is the policy owner attached to the Milestone of a recover request
	// ONLY (apply and rollback never carry it). milestone constructs the Milestone;
	// nil selects executionapp.NewMilestone.
	recovery  releaseport.HelperRecoveryPolicies
	milestone func(context.Context, releaseport.HelperRequest, ...releaseport.HelperRecoveryPolicies) (*executionapp.Milestone, error)
}

func liveHelperProductionDependencies() liveHelperDependencies {
	return liveHelperDependencies{
		take: takeLiveHelperFiles,
		open: func(ctx context.Context, r releaseport.HelperRequest, u time.Time) (closedHelperRoutes, error) {
			if runtime.GOOS != "darwin" {
				return nil, closedHelperFail(false)
			}
			return helperroutes.OpenExisting(ctx, r.Home, r.OperationID, *r.InstallLocation, u)
		},
		admission: newLiveHelperAdmission,
		ready:     closedHelperReady,
		execute:   closedHelperExecute,
		measure:   liveHelperMeasureSelf,
		now:       time.Now,
		recovery:  helperRecoveryPolicies{},
		milestone: executionapp.NewMilestone,
	}
}

// liveHelperMilestone constructs the request's Milestone. The recovery policy
// owner is attached for a recover request alone: apply and rollback keep the
// policy-free Milestone, exactly as the closed helper does.
func liveHelperMilestone(ctx context.Context, request releaseport.HelperRequest, deps liveHelperDependencies) (*executionapp.Milestone, error) {
	construct := deps.milestone
	if construct == nil {
		construct = executionapp.NewMilestone
	}
	if request.Action == "recover" {
		return construct(ctx, request, deps.recovery)
	}
	return construct(ctx, request)
}

// liveHelperValid is the accepted subset: a live predecessor (no closed proof, no
// inherited lease), an explicit physical install location, and apply or rollback
// with relaunch either way, or recover WITH relaunch (the desktop's Recover
// button; offline recover has no production caller and stays refused).
// Everything else is refused before any IO or frame.
func liveHelperValid(r releaseport.HelperRequest) bool {
	return r.Predecessor == nil && r.LeaseIdentity == nil && r.InstallLocation != nil &&
		(r.Action == "apply" || r.Action == "rollback" || r.Action == "recover" && r.Relaunch)
}

// liveHelperMeasureSelf is the boot-composed ProcessObservation of this helper
// (the hint's pid and process start). It captures the start once through the
// process-wait policy over a native probe, and joins that probe before
// returning, on every path. A clean, non-uncertain observation refusal becomes
// a launch_helper_identity refusal; a join failure or anything else stays an
// opaque error the runtime classifies as uncertain.
func liveHelperMeasureSelf(ctx context.Context, until time.Time) (releaseport.HelperSelfIdentity, error) {
	pid := os.Getpid()
	probe, err := processprobe.New(pid)
	if err != nil {
		return releaseport.HelperSelfIdentity{}, err
	}
	return liveHelperMeasureWith(ctx, until, pid, probe, liveHelperClock{})
}

// liveHelperProbe is the native probe's surface: an observation and the join of
// that original observation.
type liveHelperProbe interface {
	releaseport.ProcessProbe
	Join() error
}

// liveHelperMeasureWith is the measurement over an injected probe and clock, so
// every path's join can be witnessed deterministically.
func liveHelperMeasureWith(ctx context.Context, until time.Time, pid int, probe liveHelperProbe, clock releaseport.ProcessWaitClock) (releaseport.HelperSelfIdentity, error) {
	start, captureErr := processwait.Capture(ctx, until, probe, clock)
	joinErr := probe.Join()
	if joinErr != nil || captureErr != nil {
		if f, ok := captureErr.(*processwait.Failure); ok && f != nil && !f.Uncertain && joinErr == nil {
			return releaseport.HelperSelfIdentity{}, &releaseport.HelperRecoveryFailure{Code: "launch_helper_identity", Phase: "refused", Cause: captureErr}
		}
		return releaseport.HelperSelfIdentity{}, closedHelperJoin(true, captureErr, joinErr)
	}
	return releaseport.HelperSelfIdentity{PID: int64(pid), ProcessStart: start}, nil
}

func withLiveReleaseHelperDependencies(ctx context.Context, files liveHelperFiles, until time.Time, fn func(closedReleaseHelper) error, deps liveHelperDependencies) (result error) {
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
	if fn == nil || input == nil || channels == nil || deps.now == nil {
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
	// Offline recover and every other unsupported shape are refused here, before
	// any IO or frame, so no later step can reach a recovery effect.
	if !liveHelperValid(request) {
		return closedHelperFail(false)
	}
	// Relaunch capabilities exist only for a request that asked for them. The
	// hint is built by the protocol owner bound to THIS request ("completed" is
	// the phase the relaunched desktop expects), never from request-supplied text.
	var relaunch *closedHelperRelaunch
	if request.Relaunch {
		relaunch = &closedHelperRelaunch{
			arguments: func(c context.Context, self releaseport.HelperSelfIdentity, captured *string) ([]string, error) {
				return protocol.BuildRelaunchArguments(c, "completed", self, captured, protocolnative.JSONCodec{})
			},
			measure: deps.measure,
		}
	}
	if err := closedHelperBounds(effective, until); err != nil {
		return err
	}
	// From here the request is known: a provably clean pre-ACK refusal is sent as
	// the one refused frame (see closedHelperRefusalPath) instead of staying silent.
	refusal := &closedHelperRefusalPath{ctx: effective, until: until, protocol: protocol, operationID: request.OperationID, emit: channels.Emit, exposed: &exposed}
	milestone, err := liveHelperMilestone(effective, request, deps)
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
	routes, err := deps.open(effective, request, until)
	if err != nil {
		return refusal.refuse(err)
	}
	if routes == nil {
		return closedHelperFail(true)
	}
	return refusal.finish(func() (err error) {
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
			writeReleaseHelperLog(borrow.Operation, "starting", "")
			defer func() {
				if err != nil {
					writeReleaseHelperLog(borrow.Operation, "failed", helperLogCode(err))
				}
			}()
			admission, err := deps.admission(borrow, request, expected, until)
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
			// Python takes the update lock for a live predecessor BEFORE reading the
			// marker or waiting (update_lock(update) right after the route opens).
			if err = admission.AcquireUpdate(effective); err != nil {
				return refusal.refuse(err)
			}
			if err = check(); err != nil {
				return err
			}
			if err = admission.Capture(effective); err != nil {
				return refusal.refuse(err)
			}
			if err = check(); err != nil {
				return err
			}
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
				err = closedHelperFail(true)
				preflight.retainUnknown(err)
				return err
			}
			// The original process must be positively identified BEFORE it may be told
			// to exit; an absent PID is never inferred (Python process_start check).
			if err = admission.Confirm(effective); err != nil {
				return refusal.refuse(err)
			}
			frame, err := protocol.BuildHandoff(effective, protocolapp.WaitingForExit, nil)
			if err != nil {
				return closedHelperFail(false, err)
			}
			if err = check(); err != nil {
				return err
			}
			// One actual attempt. The frame lets the desktop quit; from here every
			// failure may follow an exposed effect and is classified unknown.
			exposed = true
			if err = channels.Emit(effective, until, frame); err != nil {
				return closedHelperFail(true, err)
			}
			// No custody check between the frame and the observed exit: the desktop
			// quits on the frame, and its marker is expected to vanish.
			waitUntil := until
			if budget := deps.now().Add(time.Duration(request.WaitSeconds) * time.Second); budget.Before(waitUntil) {
				waitUntil = budget
			}
			writeReleaseHelperLog(borrow.Operation, "waiting_for_exit", "")
			if err = admission.Wait(effective, waitUntil); err != nil {
				return closedHelperFail(true, err)
			}
			if err = admission.Quit(effective); err != nil {
				return closedHelperFail(true, err)
			}
			if err = check(); err != nil {
				return err
			}
			writeReleaseHelperLog(borrow.Operation, "predecessor_exited", "")
			state := &closedReleaseHelperState{active: true, files: borrow, request: closedHelperRequestCopy(request), original: effective, until: until, admission: admission, milestone: milestone, readiness: readiness, execution: deps.execute, relaunch: relaunch, updateHeld: true}
			scoped = state
			defer func() {
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
	}())
}

// liveHelperClock is the production ProcessWaitClock: wall time and a
// cancelable sleep.
type liveHelperClock struct{}

func (liveHelperClock) Now() time.Time { return time.Now() }
func (liveHelperClock) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

const (
	liveHelperPhaseNone int32 = iota
	liveHelperPhaseMarked
	liveHelperPhaseQuit
)

type liveHelperNativeAdmission struct {
	quitNote          string
	files             helperroutes.Files
	until             time.Time
	live              *handoff.Live
	slot              *slotbinding.Verifier
	update, promotion *helperlocks.Lease
	probeJoin         func() error // Original observer only; no replacement observation.
	phase             atomic.Int32
}

func newLiveHelperAdmission(files helperroutes.Files, r releaseport.HelperRequest, expected []byte, until time.Time) (liveHelperAdmission, error) {
	probe, err := processprobe.New(int(r.PID))
	if err != nil {
		return nil, err
	}
	slot, err := slotbinding.NewVerifier(files.Operation, slotbinding.Identity(files.OperationIdentity), expected, until)
	if err != nil {
		return nil, liveHelperCtorFail(err, probe)
	}
	waiter, err := processwait.New(r.ProcessStart, probe, liveHelperClock{})
	if err != nil {
		return nil, liveHelperCtorFail(err, probe)
	}
	live, err := handoff.NewLive(r.Home, files.Home, files.State, handoff.Identity(files.StateIdentity), int(r.PID), r.ProcessStart, waiter, until)
	if err != nil {
		return nil, liveHelperCtorFail(err, probe)
	}
	return &liveHelperNativeAdmission{files: files, until: until, live: live, slot: slot, probeJoin: probe.Join}, nil
}

// liveHelperCtorFail joins the original observation after a failed constructor.
// A clean constructor error stays direct when that observation also ended
// cleanly, so its classification survives; any Join failure makes it unknown.
func liveHelperCtorFail(err error, probe *processprobe.Probe) error {
	if joined := probe.Join(); joined != nil {
		return closedHelperJoin(false, err, joined)
	}
	return err
}

func (a *liveHelperNativeAdmission) Check(ctx context.Context) error {
	if err := a.files.Reverify(ctx); err != nil {
		return err
	}
	if err := a.slot.Verify(ctx); err != nil {
		return err
	}
	if a.update != nil {
		if err := a.update.Verify(ctx); err != nil {
			return err
		}
	}
	switch a.phase.Load() {
	case liveHelperPhaseMarked:
		if err := a.live.CheckMarker(ctx); err != nil {
			return err
		}
	case liveHelperPhaseQuit:
		if a.promotion == nil {
			return closedHelperFail(true)
		}
		if err := a.promotion.Verify(ctx); err != nil {
			return err
		}
		// The original process exit and held promotion lease admit the swap.
		// A drain receipt is diagnostic and cannot revoke that observed exit.
	}
	return closedHelperBounds(ctx, a.until)
}

func (a *liveHelperNativeAdmission) AcquireUpdate(ctx context.Context) error {
	if a.update != nil {
		return closedHelperFail(false)
	}
	lease, err := helperlocks.AcquireUpdate(ctx, helperlocks.Directory{File: a.files.Update, Identity: helperlocks.Identity(a.files.UpdateIdentity)}, a.until)
	a.update = lease
	return err
}

func (a *liveHelperNativeAdmission) Capture(ctx context.Context) error {
	if a.phase.Load() != liveHelperPhaseNone {
		return closedHelperFail(false)
	}
	if err := a.live.CaptureMarker(ctx); err != nil {
		return err
	}
	a.phase.Store(liveHelperPhaseMarked)
	return nil
}

func (a *liveHelperNativeAdmission) Confirm(ctx context.Context) error {
	if a.phase.Load() != liveHelperPhaseMarked {
		return closedHelperFail(false)
	}
	return a.live.ConfirmIdentity(ctx)
}

func (a *liveHelperNativeAdmission) Wait(ctx context.Context, until time.Time) error {
	if a.phase.Load() != liveHelperPhaseMarked {
		return closedHelperFail(false)
	}
	return a.live.WaitExit(ctx, until)
}

func (a *liveHelperNativeAdmission) Quit(ctx context.Context) error {
	if a.phase.Load() != liveHelperPhaseMarked || a.promotion != nil {
		return closedHelperFail(false)
	}
	lease, err := helperlocks.AcquirePromotion(ctx, helperlocks.Directory{File: a.files.State, Identity: helperlocks.Identity(a.files.StateIdentity)}, a.until)
	a.promotion = lease
	if err != nil {
		return err
	}
	a.quitNote, err = a.live.ObserveUpdateQuit(ctx)
	if err != nil {
		return err
	}
	a.phase.Store(liveHelperPhaseQuit)
	return nil
}

func (a *liveHelperNativeAdmission) Close() error {
	var closePromotion, closeUpdate func() error
	if a.promotion != nil {
		closePromotion = a.promotion.Close
	}
	if a.update != nil {
		closeUpdate = a.update.Close
	}
	return closeLiveHelperOwners(a.probeJoin, closePromotion, closeUpdate)
}

// closeLiveHelperOwners joins the original observation before releasing either
// lease, then releases the promotion lease and the update lock. Every failure
// remains a cause; none becomes a successful release.
func closeLiveHelperOwners(join, closePromotion, closeUpdate func() error) error {
	var joined, promoted, closed error
	if join != nil {
		joined = join()
	}
	if closePromotion != nil {
		promoted = closePromotion()
	}
	if closeUpdate != nil {
		closed = closeUpdate()
	}
	return closedHelperJoin(false, joined, promoted, closed)
}

// takeLiveHelperFiles applies the closed role checks to the two live descriptors:
// fd3 request and fd4 ACK, each a unique FIFO or stream socket. Ownership of both
// transfers on call, including failure.
func takeLiveHelperFiles(f liveHelperFiles) (closedHelperInput, liveHelperChannels, error) {
	var result error
	seen := map[*os.File]bool{}
	var consumed []closedHelperFileRole
	for i, file := range []*os.File{f.Request, f.ACK} {
		if file == nil || seen[file] {
			result = closedHelperJoin(false, result, closedHelperFail(false))
			continue
		}
		seen[file] = true
		role, err := inspectClosedHelperRole(file, []int{liveHelperRequestFD, liveHelperACKFD}[i])
		result = closedHelperJoin(false, result, err)
		consumed = append(consumed, role)
		if !role.inspected || role.stat.Mode&unix.S_IFMT != unix.S_IFIFO && role.stat.Mode&unix.S_IFMT != unix.S_IFSOCK {
			result = closedHelperJoin(false, result, closedHelperFail(false))
		}
	}
	if result != nil {
		for _, role := range consumed {
			owner, err := helperchannels.TakeRequest(role.file)
			result = closedHelperJoin(false, result, err)
			if owner != nil {
				result = closedHelperJoin(false, result, owner.Close())
			}
		}
		return nil, nil, result
	}
	input, err := helperchannels.TakeRequest(f.Request)
	channels, other := helperchannels.Take(f.ACK, nil)
	return input, channels, closedHelperJoin(false, err, other)
}

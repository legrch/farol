package boot

import (
	"context"
	"regexp"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	"github.com/legrch/farol/modules/release/app/services/helperrecovery"
	release "github.com/legrch/farol/modules/release/domain"
	executionnative "github.com/legrch/farol/modules/release/infra/native/execution"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	releasestate "github.com/legrch/farol/modules/release/infra/native/state"
	"github.com/legrch/farol/modules/release/infra/repos/journal"
	"github.com/legrch/farol/modules/release/infra/repos/rejection"
)

// closedHelperJournalAdmission is the ONE production releaseport.JournalAdmission
// of the closed helper. Unlike closedHelperJournalObservation it is a writer
// admission, so it exists only for the post-AcquireUpdate callback scope: the
// helper it borrows must have actually acquired the update lock. Its gate is
// private to one execution and is shared by that execution's journal and
// rejection repositories. Reverify takes only the scope's native mutex through
// closedReleaseHelper.reverify, never this gate. Uncertainty is the scope's own
// sticky state, which readback, Close and a new repository cannot clear.
type closedHelperJournalAdmission struct {
	helper    closedReleaseHelper
	gate      releaseport.StateGate
	operation release.Operation
	binding   releaseport.JournalDirectory
}

var _ releaseport.JournalAdmission = (*closedHelperJournalAdmission)(nil)

// held is the explicit proof that AcquireUpdate succeeded. The native
// admission's Check verifies the update lease only when one exists, so a scope
// that never acquired it would otherwise pass. Only the post-AcquireUpdate
// callback state carries the fact; the preflight scope never does.
func (a *closedHelperJournalAdmission) held() bool {
	return a != nil && a.helper.state != nil && a.helper.state.updateHeld
}

func (a *closedHelperJournalAdmission) JournalGate() releaseport.StateGate {
	if !a.held() {
		return nil
	}
	return a.gate
}

func (a *closedHelperJournalAdmission) ReverifyJournal(ctx context.Context, op release.Operation, binding releaseport.JournalDirectory) error {
	if !a.held() || ctx == nil || op != a.operation || binding != a.binding {
		return releaseport.JournalUnproven
	}
	return a.helper.reverify(ctx, a.helper.state.request)
}

func (a *closedHelperJournalAdmission) JournalUnknown(op release.Operation) bool {
	return !a.held() || op != a.operation || a.helper.unknown() != nil
}

func (a *closedHelperJournalAdmission) RetainJournalUnknown(release.Operation) {
	if a != nil {
		a.helper.retainUnknown(nil)
	}
}

// closedHelperExecution is everything the one execution step may use. The
// request is the scope's captured copy; the helper is the same custody owner.
type closedHelperExecution struct {
	files     helperroutes.Files
	request   releaseport.HelperRequest
	until     time.Time
	helper    closedReleaseHelper
	milestone *executionapp.Milestone
	readiness *executionapp.Readiness
	// relaunch carries the launch capabilities of the LIVE helper only. The
	// closed helper leaves it nil, so a relaunch can never resolve there: the
	// runtime refuses with launch_helper_identity before any launch effect.
	relaunch *closedHelperRelaunch
}

// closedHelperRelaunch is the boot-composed pair the installation runtime needs
// for a relaunch. Neither value is request-supplied authority: arguments are
// built by the protocol owner for the already bound request, and measure
// observes this very process.
type closedHelperRelaunch struct {
	arguments func(context.Context, releaseport.HelperSelfIdentity, *string) ([]string, error)
	measure   func(context.Context, time.Time) (releaseport.HelperSelfIdentity, error)
}

// closedHelperExecutor is the private seam behind closedReleaseHelper.execute.
// Production supplies closedHelperExecute; tests supply symbolic stand-ins.
type closedHelperExecutor func(context.Context, closedHelperExecution) (*executionapp.Result, error)

// closedHelperExecute opens the existing journal and rejection repositories over
// the borrowed operation directory with ONE admission and ONE gate, then runs
// Milestone.Execute exactly once through the existing installation runtime.
// The launch port is the same native runtime. It is inert unless the request
// asked for relaunch AND the execution carries the live helper's relaunch
// capabilities; the closed helper refuses relaunch before any IO and supplies
// none.
func closedHelperExecute(ctx context.Context, in closedHelperExecution) (result *executionapp.Result, err error) {
	if ctx == nil || in.milestone == nil || in.readiness == nil || in.files.Operation == nil {
		return nil, closedHelperFail(false)
	}
	operation, binding, directory := closedHelperOperationBinding(in.request, in.files)
	admission := &closedHelperJournalAdmission{helper: in.helper, gate: releasestate.New(), operation: operation, binding: binding}
	closeOwner := func(closeFn func() error) {
		if e := closeFn(); e != nil {
			result = nil
			err = closedHelperFail(true, err, e)
		}
	}
	repository, err := journal.New(ctx, directory, operation, admission)
	if err != nil {
		return nil, err
	}
	defer closeOwner(repository.Close)
	rejected, err := rejection.New(ctx, in.files.Operation, binding, operation, admission, in.until)
	if err != nil {
		return nil, err
	}
	defer closeOwner(rejected.Close)
	err = executionnative.WithAdmittedInstallation(ctx, closedHelperNativeConfig(in, repository, rejected), func(native executionnative.AdmittedInstallation) error {
		executed, e := in.milestone.Execute(ctx, native, in.readiness, native)
		if e == nil {
			result = executed
		}
		return e
	})
	if err != nil {
		result = nil
	}
	return result, err
}

// closedHelperNativeConfig is the installation runtime's configuration for one
// execution. The launch capabilities are the live helper's alone: an execution
// without them leaves both nil, so the runtime refuses any launch.
func closedHelperNativeConfig(in closedHelperExecution, repository releaseport.HelperJournalRepository, rejected releaseport.HelperTargetRejectionRepository) executionnative.Config {
	config := executionnative.Config{
		Request: in.request, Files: in.files, Journal: repository, Rejection: rejected, Until: in.until,
		Reverify: in.helper.reverify, Unknown: in.helper.unknown, RetainUnknown: in.helper.retainUnknown,
	}
	if in.relaunch != nil {
		config.RelaunchArguments, config.MeasureSelf = in.relaunch.arguments, in.relaunch.measure
	}
	return config
}

// closedHelperCleanRefusal recognizes only a direct, non-nil application
// Failure that is neither Internal nor Uncertain. The application owner already
// classifies its causes (operation.call joins every native cause into Cause and
// derives Internal/Uncertain from them), so those flags are authoritative and
// no second cause rule applies here. Wrapped, joined, typed-nil and non-Failure
// errors are unknown.
func closedHelperCleanRefusal(err error) bool {
	_, _, ok := closedHelperCleanFailureOf(err)
	return ok
}

// closedHelperCleanFailureOf is the one reading of such a refusal: the direct
// application Failure of the execution owner, or of the original recovery owner
// (a live recover surfaces its Inspect, Recheck and Reconcile errors unchanged).
// Each owner's OWN Internal/Uncertain flags are authoritative; nothing unwraps.
func closedHelperCleanFailureOf(err error) (phase, code string, ok bool) {
	switch f := err.(type) {
	case *executionapp.Failure:
		if f != nil && !f.Internal && !f.Uncertain {
			return f.Phase, f.Code, true
		}
	case *helperrecovery.Failure:
		if f != nil && !f.Internal && !f.Uncertain {
			return f.Phase, f.Code, true
		}
	}
	return "", "", false
}

// execute runs the retained Milestone exactly once, inside the post-AcquireUpdate
// callback scope. It consumes the scope's single nested borrow, so a second call
// (or a withFiles call) refuses without a second Execute. Custody is rechecked
// before and after; a failed post fence after Execute returned can never be a
// success, whatever Execute reported. A direct, clean application refusal is
// returned unchanged and retains nothing; every other failure is retained as
// sticky unknown and returned wrapped.
func (s closedReleaseHelper) execute(ctx context.Context) (result *executionapp.Result, err error) {
	if s.state == nil {
		return nil, closedHelperFail(false)
	}
	o := s.state
	if err = o.begin(true); err != nil {
		return nil, err
	}
	defer o.calls.Done()
	defer func() {
		if err == nil || closedHelperCleanRefusal(err) {
			return
		}
		result = nil
		o.retainUnknown(err)
		err = closedHelperFail(true, err)
	}()
	if ctx == nil || !o.updateHeld || o.execution == nil || o.milestone == nil || o.readiness == nil {
		return nil, closedHelperFail(false)
	}
	if err = s.reverify(ctx, o.request); err != nil {
		return nil, err
	}
	effective, cancel := closedHelperEffective(ctx, o.original, o.until)
	defer cancel()
	var executed *executionapp.Result
	err = closedHelperCall(func() (e error) {
		executed, e = o.execution(effective, closedHelperExecution{
			files: o.files, request: closedHelperRequestCopy(o.request), until: o.until,
			helper: s, milestone: o.milestone, readiness: o.readiness, relaunch: o.relaunch,
		})
		return e
	})
	if err != nil {
		return nil, err
	}
	if executed == nil {
		return nil, closedHelperFail(true)
	}
	value := *executed
	if err = s.reverify(ctx, o.request); err != nil {
		return nil, closedHelperFail(true, err)
	}
	return &value, nil
}

var (
	closedHelperPhasePattern = regexp.MustCompile(`^[a-z_]{1,40}$`)
	closedHelperCodePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)
	closedHelperIDPattern    = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

const (
	closedHelperExitOK      = 0
	closedHelperExitRefusal = 70
	closedHelperExitUnknown = 79
)

// closedHelperTerminal is the pure terminal classification of one execution. It
// reproduces the Python helper's stdout and exit contract
// (emit_terminal / main in resources/native/update_helper.py): the line is
// json.dumps of a dict built in the order phase, [error], operationId, with
// ", " and ": " separators and one trailing newline.
//
//	success          {"phase": P, "operationId": ID}              exit 0
//	refusal          {"phase": P, "error": C, "operationId": ID}  exit 70
//	pre-ACK refusal  the same line, after one refused handoff frame was written
//	anything else    {"phase": "unknown", "error": "internal", "operationId": ID}  exit 79
//
// A non-nil error always governs, even beside a result: a custody failure after
// an effect must never read as success. Only a direct, non-internal,
// non-uncertain *executionapp.Failure is a refusal; wrapped, joined, internal,
// uncertain or non-Failure errors, a malformed phase or code, a nil result with
// no error, and an operation ID that is not 32 lowercase hex digits are unknown.
// An unusable ID is omitted, exactly as Python omits it without a request.
func closedHelperTerminal(operationID string, result *executionapp.Result, err error) (line []byte, exit int) {
	// A refused frame was already sent for this exact operation: its own ID,
	// phase and code govern, and the line reports the same refusal as exit 70.
	if refused, ok := err.(*closedHelperRefused); ok && refused != nil {
		if !closedHelperIDPattern.MatchString(refused.operationID) || !closedHelperPhasePattern.MatchString(refused.phase) || !closedHelperCodePattern.MatchString(refused.code) {
			return closedHelperTerminalLine("unknown", "internal", operationID, closedHelperIDPattern.MatchString(operationID)), closedHelperExitUnknown
		}
		return closedHelperTerminalLine(refused.phase, refused.code, refused.operationID, true), closedHelperExitRefusal
	}
	idOK := closedHelperIDPattern.MatchString(operationID)
	unknown := func() ([]byte, int) {
		return closedHelperTerminalLine("unknown", "internal", operationID, idOK), closedHelperExitUnknown
	}
	if !idOK {
		return unknown()
	}
	if err != nil {
		phase, code, ok := closedHelperCleanFailureOf(err)
		if !ok || !closedHelperPhasePattern.MatchString(phase) || !closedHelperCodePattern.MatchString(code) {
			return unknown()
		}
		return closedHelperTerminalLine(phase, code, operationID, true), closedHelperExitRefusal
	}
	if result == nil || !closedHelperPhasePattern.MatchString(result.Phase) {
		return unknown()
	}
	if result.Code == "" {
		return closedHelperTerminalLine(result.Phase, "", operationID, true), closedHelperExitOK
	}
	if !closedHelperCodePattern.MatchString(result.Code) {
		return unknown()
	}
	return closedHelperTerminalLine(result.Phase, result.Code, operationID, true), closedHelperExitRefusal
}

// closedHelperTerminalLine builds the dict text. Every interpolated value was
// validated against an ASCII-only pattern by the caller, so no escaping applies.
func closedHelperTerminalLine(phase, code, operationID string, withID bool) []byte {
	line := `{"phase": "` + phase + `"`
	if code != "" {
		line += `, "error": "` + code + `"`
	}
	if withID {
		line += `, "operationId": "` + operationID + `"`
	}
	line += "}\n"
	return []byte(line)
}

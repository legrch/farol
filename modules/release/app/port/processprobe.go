package port

import (
	"context"
	"time"
)

// A process snapshot grants no execution, termination or admission authority.
type ProcessPresence uint8

const (
	ProcessUnknown ProcessPresence = iota
	ProcessAbsent
	ProcessPresent
)

// Present carries the existing opaque ps lstart token; absent carries no token.
// Unknown and malformed observations must never establish absence.
type ProcessObservation struct {
	Presence ProcessPresence
	Start    string
}

type ProcessProbeFailureKind uint8

const (
	ProcessProbeUnknown ProcessProbeFailureKind = iota
	ProcessProbeInput
	ProcessProbeCanceled
	ProcessProbeDeadline
	ProcessProbeCleanupUnknown
	ProcessProbeStartFailure
)

// A timeout or uncertain child cleanup remains distinct from a completed
// negative observation. Future helper composition must retain that distinction
// when mapping terminal refused versus unknown states.
type ProcessProbeFailure struct{ Kind ProcessProbeFailureKind }

func (f *ProcessProbeFailure) Error() string { return "release_process_observation_failed" }

// Implementations bind the target PID before Observe. until is the original
// nonzero absolute deadline; observation and cleanup never renew authority.
// Only an explicit positively established ProcessAbsent can prove absence.
// Implementations retain the exact original observation child, perform no
// target-process control, and disclose only bounded validated observations.
// Trusted composition supplies non-panicking, non-typed-nil implementations;
// pure app constructors do not inspect runtime object identity.
type ProcessProbe interface {
	Observe(context.Context, time.Time) (ProcessObservation, error)
}

// Clock/timer effects remain outside the pure application owner. Implementations
// must preserve monotonic time in process and honor cancellation while sleeping.
type ProcessWaitClock interface {
	Now() time.Time
	Sleep(context.Context, time.Duration) error
}

// ProcessWaiter is the live handoff consumer's prepared process lifecycle port.
// Boot binds the original application service to one probe/start token. Neither
// a successful wait nor this interface grants closed custody or writer admission.
// Implementations retain the original absolute bound and trusted non-typed-nil
// dependency contract; the native handoff owner never constructs app policy.
type ProcessWaiter interface {
	ConfirmIdentity(context.Context, time.Time) error
	WaitExit(context.Context, time.Time) error
}

// ProcessSignal names the only two termination signals a drained-predecessor
// finish may send. It grants nothing by itself.
type ProcessSignal uint8

const (
	ProcessSignalTerminate ProcessSignal = iota + 1
	ProcessSignalKill
)

// ProcessTerminator is bound by trusted composition to exactly one PID and one
// installed application slot. Each Signal re-reads the kernel executable path
// of that PID and refuses unless it lies inside the bound slot. A signal error
// never establishes absence; only the waiter's own probe does.
type ProcessTerminator interface {
	Signal(context.Context, ProcessSignal) error
}

// ProcessStopper finishes the one process a waiter already identified, after
// its wait reached the deadline with that process still running. It returns
// nil only after a positively observed exit.
type ProcessStopper interface {
	Stop(context.Context, time.Time) error
}

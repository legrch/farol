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

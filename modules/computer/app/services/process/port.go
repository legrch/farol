// Package process owns one selected process operation, not a task lifecycle.
package process

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Execution is the SAME immutable lease selected before this operation. Neither
// construction nor Binding grants admission. There is no renewal method here.
type Execution interface {
	port.ExecutionAccessRepository
	Deadline() time.Time
}

type Gate interface {
	Lock()
	Unlock()
}

// Seal is immutable correlation from a trusted prepared native launch. It is
// never supplied by a request and is not itself permission or confinement proof.
type Seal struct {
	Digest, WorkspaceID, Root, Cwd string
	RootIdentity                   authority.RootIdentity
	Write                          bool
}

type Intent struct {
	OperationID string
	Binding     port.TaskBinding
	Seal        Seal
	Deadline    time.Time
}

type ReservationStatus string

const (
	Reserved ReservationStatus = "reserved"
	Existing ReservationStatus = "existing"
)

type ReservationReceipt struct {
	Status ReservationStatus
	Intent Intent
}

// Reserve atomically publishes the exact intent before effects. Existing is
// observation only, including after restart. Nil/error/mismatched ACK is unknown.
// The root journal owner supplies this port; this module does not add a journal.
type Reservation interface {
	Reserve(context.Context, Intent) (*ReservationReceipt, error)
}

type SpawnRequest struct {
	Deadline time.Time
	// Check re-observes the selected current owners after native preparation and
	// immediately before the one start attempt, outside every app/owner gate.
	Check func(context.Context) error
}

// Prepared is a selected launch, never a lookup by body IDs. Spawn is one attempt.
// Its producer owns the exact child, output, deadline and cancellation request.
// It must not automatically signal again after a refused/unknown signal.
type Prepared interface {
	Seal() Seal
	Spawn(context.Context, SpawnRequest) (Child, error)
}

type RootState string

const (
	RootRunning RootState = "running"
	RootExited  RootState = "exited"
)

type Cleanup string

const (
	CleanupPending    Cleanup = "pending"
	CleanupConfirmed  Cleanup = "confirmed"
	CleanupUnverified Cleanup = "unverified"
)

type Window struct{ StdoutOffset, StderrOffset uint64 }
type Observation struct {
	Handle                                                                      string
	Root                                                                        RootState
	Waited                                                                      bool
	ExitCode                                                                    *int
	ExitSignal                                                                  int
	GroupCleanup, DescendantCleanup                                             Cleanup
	Stdout, Stderr                                                              []byte
	StdoutOffset, StderrOffset, StdoutNext, StderrNext                          uint64
	StdoutBytes, StderrBytes                                                    uint64
	OutputLimitReached, OutputDrained, CancelRequested, TimedOut, AuthorityLost bool
}

type CancelStatus string

const (
	CancelRequested CancelStatus = "requested"
	AlreadyTerminal CancelStatus = "already_terminal"
	CancelUnknown   CancelStatus = "unknown"
)

type CancelReceipt struct {
	Handle string
	Status CancelStatus
}

type Child interface {
	Handle() string
	Read(context.Context, Window) (*Observation, error)
	Cancel(context.Context) (*CancelReceipt, error)
}

// NativeFailure classifies a one-attempt boundary result without disclosing OS
// errors/paths. Unknown is irreversible here; it never authorizes another effect.
type NativeFailure struct{ Unknown bool }

func (e *NativeFailure) Error() string { return "PROCESS_NATIVE_UNAVAILABLE" }

// Scope comes from the trusted selected runtime producer, never a request. It
// is correlation/policy context, not admission or native qualification proof.
type Scope struct {
	RuntimeID, WorkspaceID, Root, Cwd string
	RootIdentity                      authority.RootIdentity
	Write                             bool
}

// Invocation is the exact consumer-selected CLI input. AdmissionID must match
// the selected lease's existing Grant.AuthorityID. Session/model are exact opaque
// provider correlation, not entitlement, permission or latest-session lookup.
type Invocation struct {
	RuntimeID, SessionID, ModelID, AdmissionID string
	Arguments                                  []string
	Input                                      []byte
}

func (v Invocation) Clone() Invocation {
	v.Arguments = append([]string(nil), v.Arguments...)
	v.Input = append([]byte(nil), v.Input...)
	return v
}

// Selected binds the prepared seal to an independent exact invocation copy.
// Seal/Invocation/Scope are pure immutable value observations, never native IO.
// Its digest covers runtime/session/model/admission, args/stdin and trusted
// executable/environment/root policy. It never persists command text itself.
type Selected interface {
	Prepared
	Invocation() Invocation
}

// InvocationPreparer constructs one immutable launch without process/provider
// effects, journal publication or authority renewal. IO (if needed for read-only
// preparation) runs outside owner callbacks. No unapproved executor fallback.
type InvocationPreparer interface {
	Scope() Scope
	Prepare(context.Context, Invocation) (Selected, error)
}

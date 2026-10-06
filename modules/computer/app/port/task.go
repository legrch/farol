package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// TaskBinding is the legacy execution correlation shape. For actual Task/Chat
// routes it still projects their admitted task/turn from the trusted owner.
// For an external connector, SessionID/TaskID/TaskEpoch/TurnID are opaque values
// minted by trusted root for a Computer execution lifetime, NOT membership in a
// coding task, Farol Chat, browser conversation or provider thread/turn.
// Request-body IDs are correlation, never proof. No Task/Chat lifecycle is added.
type TaskBinding struct {
	authority.Identity
	ParticipantID, TurnID string
}

// CurrentExecutionAdmission is injected by trusted composition for this route's
// current admitted execution correlation. WithCurrent calls inspect exactly once
// with an independent value, serialized against admission/revoke/binding
// changes. nil means no current admission; errors mean unavailable, not absent.
// Selected lock order is AccessRepository.WithSnapshot -> this callback.
// WithCurrent itself, including entry before inspect, must perform no native IO.
// Only MutationRequest.WithPublication may perform one workspace-parent mkdir
// or final file publication/verification/guarded undo inside inspect. Other IO stays outside.
// Neither callback may reenter or mutate these owners. Execution withdrawal
// invalidates admission under its own gate, releases it, then makes any separate
// Computer update. It must not expose stale positive admission while persistence
// or coordinated revocation is unsettled; those outcomes belong to its owner.
// No execution-owner-held path may acquire Computer access Store. The owning adapter
// must bind the route to the trusted admission before calling Computer; it cannot
// manufacture proof from a request body or an ambient "latest task" lookup.
type CurrentExecutionAdmission interface {
	WithCurrent(context.Context, func(*TaskBinding) error) error
}

// CurrentTaskAdmission preserves existing Task/Chat consumers and their meaning.
type CurrentTaskAdmission = CurrentExecutionAdmission

// ExecutionAccessRepository is one already admitted operation's immutable access
// lease. Binding is an independent correlation value; WithSnapshot remains the
// sole current-owner gate. Composition must reuse this same lease for every phase.
type ExecutionAccessRepository interface {
	AccessRepository
	Binding() TaskBinding
}

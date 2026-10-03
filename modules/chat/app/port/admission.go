// Package port defines the required owning seam for ordinary Chat admission.
package port

import (
	"context"

	"github.com/legrch/farol/modules/chat/domain/turn"
)

// TurnBinding is captured by the Chat owner when it actually admits and binds a
// turn. TaskEpoch and ParticipantID belong to that admission, not provider/body
// generation, call ID, browser ordinal, provider status or a startup cache.
// This independent application value is not a Computer or wire DTO.
type TurnBinding struct {
	ProfileID, BackendGeneration       string
	OwnerID, SessionID, TaskID         string
	TaskEpoch                          uint64
	ParticipantID, TurnID, OperationID string
	TurnGeneration                     uint64
}

type Persistence string

const (
	Committed     Persistence = "committed"
	PendingCommit Persistence = "pending"
	UnknownCommit Persistence = "unknown"
)

// CurrentTurn is an independent view produced under the real owner's current
// gate, never reconstructed here from an event, request or retained snapshot.
// Committed means both binding and the current lifecycle transition have known
// persistence. A pending/unknown write or coordinated effect is not Committed.
type CurrentTurn struct {
	Binding     TurnBinding
	Turn        turn.Snapshot
	Persistence Persistence
}

// BoundTurn is one ordinary Chat turn's existing live owner, supplied by trusted
// composition only after actual admission/binding. Capture it once for the route;
// there is no lookup by request IDs or ambient "latest task" capability.
// Binding is correlation only. WithCurrent provides the sole current-owner gate.
//
// Both methods, including entry before inspect, perform no native IO. WithCurrent
// invokes inspect exactly once, synchronously and while serialized against all
// admission, binding, completion and revoke changes. nil means no current bound
// turn; an error means unavailable. The value is independent of stored state.
// Neither owner nor callback may reenter/mutate this or Computer's owner.
//
// Lock order: qualified Computer AccessRepository -> BoundTurn.WithCurrent.
// Invalidation happens under Chat's own gate, which is released before a separate
// Computer update. Pending/unknown persistence/effects must hide positive binding.
// Journal IO, native IO and a Task/Chat-held path reacquiring Computer are forbidden
// under this gate. A historical journal/cache is never an implementation of it.
// lifecycle.Service implements this owner using its actual queue/journal gate.
// Durable adapter and boot qualification remain separate from source fixtures.
type BoundTurn interface {
	Binding() TurnBinding
	WithCurrent(context.Context, func(*CurrentTurn) error) error
}

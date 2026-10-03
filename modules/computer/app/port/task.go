package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// TaskBinding is a projection of an already admitted, currently bound task/turn
// from its existing trusted owner. Request-body IDs are correlation, not proof.
// No new task lifecycle, consent cache or authority engine is owned here.
type TaskBinding struct {
	authority.Identity
	ParticipantID, TurnID string
}

// CurrentTaskAdmission is injected by trusted composition for this route's
// current admitted task/turn. WithCurrent calls inspect exactly once with an
// independent value, synchronously serialized against admission/revoke/binding
// changes. nil means no current admission; errors mean unavailable, not absent.
// Proposed lock order is AccessRepository.WithSnapshot -> this callback.
// WithCurrent itself, including entry before inspect, must perform no native IO.
// Neither callback may reenter or mutate these owners. The owning adapter
// must bind the route to the trusted admission before calling Computer; it cannot
// manufacture proof from a request body or an ambient "latest task" lookup.
type CurrentTaskAdmission interface {
	WithCurrent(context.Context, func(*TaskBinding) error) error
}

package port

import "context"

// CurrentBinding projects an already admitted coding task and its exact current
// turn from the trusted lifecycle owner. SessionID is the Farol authority session,
// not a Codex thread or Claude session. Provider lineage is a separate fact.
type CurrentBinding struct {
	OwnerID, SessionID, TaskID string
	TaskEpoch                  uint64
	ParticipantID, TurnID      string
}

// CurrentTaskAdmission is selected by trusted composition for this coding task
// before native execution. It must not derive permission from request IDs,
// backend generation, call IDs, Journal.Progress, or an ambient latest task.
//
// WithCurrent calls inspect once with an independent value synchronously under
// the lifecycle owner's gate. nil means absent/revoked; an error means unavailable.
// Entry and callback perform no IO: no native measurements, journal/provider
// reads, status polling or Computer calls. Callbacks must not mutate/reenter an
// owner. Computer qualifies native state first, then enters this owner; no
// Task-held path may acquire Computer. Completion/revoke invalidates under this
// gate, releases it, then performs a separate Computer update. Unsettled
// persistence/revocation must fence positive admission before any possible
// effect and cannot restore it from a cached snapshot or after restart.
//
// This is a required owner port, not a new grant issuer or lifecycle engine.
// The current foundation has no production implementation; ordinary Chat turns
// require the Chat owner's separate contract instead of this Task projection.
type CurrentTaskAdmission interface {
	WithCurrent(context.Context, func(*CurrentBinding) error) error
}

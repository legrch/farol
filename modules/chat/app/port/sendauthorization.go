package port

import "context"

// SendCurrent is a send-scoped capability issued by the actual Chat owner after
// its exact dispatch is committed and controls verified. It is not an ordinary
// positive admission while an effect is pending. It expires before Send returns.
// Computer qualifies its access first, then enters this synchronous no-IO guard.
type SendCurrent interface {
	// AccountSnapshot reads only this dispatch's immutable witness, under the
	// Chat gate. It neither refreshes the provider nor authorizes disclosure.
	AccountSnapshot(context.Context) (AccountObservation, error)
	WithCurrent(context.Context, func(TurnBinding) error) error
}

// SendAuthorization is captured once by trusted composition during promotion.
// A refusal means the physical Send has not run. No callback may perform browser
// IO or retain SendCurrent as authority for a later operation.
type SendAuthorization interface {
	Authorize(context.Context, SendCurrent) error
}

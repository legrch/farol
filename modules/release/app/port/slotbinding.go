package port

import "context"

// SlotBindingDecision classifies only this immutable publication. Confirmation
// grants no update admission, helper readiness or installation acceptance.
type SlotBindingDecision uint8

const (
	SlotBindingConfirmed SlotBindingDecision = iota + 1
	SlotBindingRefused
	SlotBindingUnknown
)

type SlotBindingResult struct {
	Decision SlotBindingDecision
	Code     string
}

// SlotBindingPublisher retains uncertainty after any possibly effective call.
// Caller cancellation never authorizes replay or removal of an existing record.
type SlotBindingPublisher interface {
	Publish(context.Context, []byte) (SlotBindingResult, error)
}

// Package port defines consumer-owned browser capabilities for Chat.
// These are application values, not independently authored Desktop wire schemas.
package port

import "unicode/utf8"

// RequestIdentity is explicitly mapped to domain identity by the Chat service.
// No alias to a transport DTO, UI type or domain entity is used.
type RequestIdentity struct {
	ProfileID      string
	OwnerID        string
	SessionID      string
	TaskID         string
	TurnID         string
	OperationID    string
	TurnGeneration uint64
}

type BrowserLease struct {
	Identity          RequestIdentity
	BackendGeneration string
	SlotOrdinal       uint8
	SlotGeneration    uint64
}

type BrowserBinding struct {
	Lease              BrowserLease
	ViewID             string
	ViewGeneration     uint64
	DocumentGeneration uint64
	ConversationID     string
}

type PrepareRequest struct {
	Lease          BrowserLease
	DeadlineMillis uint64
}

type Readiness string

const (
	Ready          Readiness = "ready"
	SignInRequired Readiness = "sign-in-required"
	OwnerRequired  Readiness = "awaiting-owner"
	Unavailable    Readiness = "unavailable"
)

type PrepareResponse struct {
	Readiness Readiness
	Binding   BrowserBinding
	Code      string
}

// Prompt is transient Send input, never an Activity or journal field.
// Desktop checks the exact binding and inserted bytes before its one Send.
type SendRequest struct {
	Binding        BrowserBinding
	IntentDigest   string
	Prompt         string
	DeadlineMillis uint64
}

type SendStatus string

const (
	Submitted   SendStatus = "submitted"
	NotSent     SendStatus = "not-sent"
	SendUnknown SendStatus = "unknown"
)

type SendResponse struct {
	Binding BrowserBinding
	Status  SendStatus
	Code    string
}

// Limits apply to semantic UTF-8 text bytes, not JSON's escaped wire size.
// Core separately enforces encoded frame bounds before decoding any response.
const MaxObserveEvents = 128
const MaxObserveTextBytes = 64 * 1024
const MaxObservePageBytes = 256 * 1024

type ObserveCode string

func (c ObserveCode) Error() string { return string(c) }

const (
	ObserveInvalid     ObserveCode = "CHAT_OBSERVE_INVALID"
	ObserveCorrelation ObserveCode = "CHAT_OBSERVE_CORRELATION"
	ObserveSequence    ObserveCode = "CHAT_OBSERVE_SEQUENCE"
	ObserveGap         ObserveCode = "CHAT_OBSERVE_GAP"
)

type ObserveRequest struct {
	Binding       BrowserBinding
	AfterSequence uint64
	// Limit zero selects MaxObserveEvents; a page can never exceed that cap.
	Limit          int
	DeadlineMillis uint64
}

type ObservationKind string

const (
	Accepted       ObservationKind = "accepted"
	AnswerDelta    ObservationKind = "answer-delta"
	Commentary     ObservationKind = "commentary"
	Status         ObservationKind = "status"
	AwaitingOwner  ObservationKind = "awaiting-owner"
	Completed      ObservationKind = "completed"
	Refused        ObservationKind = "refused"
	OutcomeUnknown ObservationKind = "unknown"
	Quiescent      ObservationKind = "quiescent"
)

type BrowserObservation struct {
	Binding          BrowserBinding
	Sequence         uint64
	ObservedAtMillis uint64
	Kind             ObservationKind
	Text             string
	Code             string
}

type ObserveResponse struct {
	Events []BrowserObservation
	Gap    bool
}

type CancelRequest struct {
	Binding        BrowserBinding
	DeadlineMillis uint64
}

type CancelStatus string

const (
	CancelRequested CancelStatus = "requested"
	CancelConfirmed CancelStatus = "confirmed-terminal"
	AlreadyTerminal CancelStatus = "already-terminal"
	CancelUnknown   CancelStatus = "unknown"
)

type CancelResponse struct {
	Binding BrowserBinding
	Status  CancelStatus
	Code    string
}

// Prepared cleanup is tied to the lease even when no document was bound.
type DisposeRequest struct {
	Lease          BrowserLease
	DeadlineMillis uint64
}

type DisposeResponse struct {
	Lease     BrowserLease
	Confirmed bool
	Code      string
}

// Browser is implemented by Desktop through Core's generated bridge after K0.
// It has no arbitrary script, eval, URL navigation, cookie or storage capability.
// Every successful call returns a nonnil response; every error a nil response.
// Observe is bounded/read-only. Lost Send replies are never permission to resend.
// The adapter must enforce size, sequence, exact binding and deadline bounds at IO.
type Browser interface {
	Prepare(PrepareRequest) (*PrepareResponse, error)
	Send(SendRequest) (*SendResponse, error)
	Observe(ObserveRequest) (*ObserveResponse, error)
	Cancel(CancelRequest) (*CancelResponse, error)
	Dispose(DisposeRequest) (*DisposeResponse, error)
}

// ValidateObserveResponse runs after bounded wire decoding, before any event is
// applied. It is observation-only and cannot dispatch/resume Send on failure.
// Pages start after the exact requested sequence and carry the exact binding.
// This is port conformance, not a replacement for domain lifecycle validation.
func ValidateObserveResponse(request ObserveRequest, response *ObserveResponse) error {
	limit := request.Limit
	if limit == 0 {
		limit = MaxObserveEvents
	}
	if limit < 1 || limit > MaxObserveEvents || response == nil || len(response.Events) > limit {
		return ObserveInvalid
	}
	if response.Gap {
		return ObserveGap
	}
	sequence := request.AfterSequence
	bytes := 0
	for _, event := range response.Events {
		if event.Binding != request.Binding {
			return ObserveCorrelation
		}
		if sequence == ^uint64(0) || event.Sequence != sequence+1 {
			return ObserveSequence
		}
		switch event.Kind {
		case Accepted, AnswerDelta, Commentary, Status, AwaitingOwner, Completed, Refused, OutcomeUnknown, Quiescent:
		default:
			return ObserveInvalid
		}
		if !utf8.ValidString(event.Text) || len(event.Text) > MaxObserveTextBytes || len(event.Code) > 120 {
			return ObserveInvalid
		}
		// The page bound includes selected text and classified-code bytes.
		bytes += len(event.Text) + len(event.Code)
		if bytes > MaxObservePageBytes {
			return ObserveInvalid
		}
		sequence = event.Sequence
	}
	return nil
}

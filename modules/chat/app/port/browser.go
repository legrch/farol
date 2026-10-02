// Package port defines consumer-owned browser capabilities for Chat.
// These are application values, not independently authored Desktop wire schemas.
package port

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

type ObserveRequest struct {
	Binding        BrowserBinding
	AfterSequence  uint64
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

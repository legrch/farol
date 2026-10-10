// Package inference owns bounded, explicitly selected no-tools plan inference.
// It does not admit Browser turns, grant Computer access or create provider history.
package inference

import "context"

const (
	PlanBackend    = "chatgpt-plan-responses"
	PublicResource = "https://api.openai.com/v1"
	MaxInputItems  = 128
	MaxInputBytes  = 256 << 10
	MaxOutputBytes = 256 << 10
)

type State string

const (
	NotSent    State = "not_sent"
	Unknown    State = "unknown"
	Failed     State = "failed"
	Completed  State = "completed"
	Suppressed State = "suppressed"
)

// Code carries fixed public-safe categories, never provider messages or credentials.
type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid               Code = "INFERENCE_INVALID"
	Withdrawn             Code = "INFERENCE_WITHDRAWN"
	CredentialUnavailable Code = "INFERENCE_CREDENTIAL_UNAVAILABLE"
	ScopeMissing          Code = "INFERENCE_SCOPE_MISSING"
	Conflict              Code = "INFERENCE_OPERATION_CONFLICT"
	AlreadyReserved       Code = "INFERENCE_OPERATION_ALREADY_RESERVED"
	PersistenceUnknown    Code = "INFERENCE_PERSISTENCE_UNKNOWN"
	Cancelled             Code = "INFERENCE_CANCELLED"
	PublicationUnknown    Code = "INFERENCE_PUBLICATION_UNKNOWN"
)

// Identity separates verified user/client/host identity from catalogue and token epochs.
type AccountIdentity struct {
	Issuer, Subject, ClientID, HostID string
	Epoch                             uint64
}

// ModelSelection is a detached consumer value. Catalogue evidence is not entitlement.
// MODELS' accepted values must be mapped here by its integration owner.
type ModelSelection struct {
	Slug, Effort, CapabilityEvidence string
	CatalogueEpoch                   uint64
}

type Selection struct {
	Backend         string
	Account         AccountIdentity
	ConsentID       string
	ConsentRevision uint64
	Model           ModelSelection
}

// ContextSelection binds an immutable ordered input. Token counts are estimates.
// CONTEXT's accepted bounded value is mapped here, without altering unresolved rounds.
type ContextSelection struct {
	CheckpointID, InputHash     string
	EstimatedTokens, TokenLimit uint64
}

type Binding struct {
	OperationID, ProfileID, BackendGeneration, OwnerID, SessionID string
	Selection                                                     Selection
	Context                                                       ContextSelection
	DeadlineMillis                                                uint64
}

// InputItem is a closed no-tools history value. Prior function call/results may be
// retained as context, but this request grants no function execution capability.
type InputItem struct {
	Kind, Role, Content, CallID, Name, Arguments string
}

type Request struct {
	Model ModelSelection
	Input []InputItem
	// DeadlineMillis is transport metadata, never a Responses body field.
	DeadlineMillis uint64
}

// Credential is transient app-owned material. Never serialize, log or retain it
// in operation/result metadata. The provider must bind it to the original account.
type Credential struct {
	Account                        AccountIdentity
	AccessToken                    string
	RequestedScopes, GrantedScopes []string
	ExpiresAtMillis, Generation    uint64
}

type Outcome struct {
	State State
	// RemoteState preserves observed remote facts when local delivery is suppressed.
	RemoteState      State
	ResponseID, Text string
	Code             Code
	HTTPStatus       int
}

type Clock interface{ NowMillis() uint64 }

// Deadline derives a bounded child of the caller context for every operation
// port. The owning infrastructure supplies the clock-based implementation.
type Deadline interface {
	Limit(context.Context, uint64) (context.Context, context.CancelFunc, error)
}
type Digester interface{ Digest([]byte) (string, error) }
type Credentials interface {
	Acquire(context.Context, Selection) (Credential, error)
}
type Transport interface {
	Infer(context.Context, Credential, Request) Outcome
}

// Authority pins the original consent/selection/lease. The complete callback is
// synchronous, serialized with withdrawal, and performs no IO or owner reentry.
// A physical delivery adapter must check this same authority before its own write.
type Authority interface {
	WithCurrent(context.Context, Binding, func() error) error
}

// Ledger is an extension point for the existing owning journal, not a new store.
// Reserve must atomically consume an operation before any provider IO; uncertain
// reservation/settlement is sticky. No implementation is silently supplied here.
type Ledger interface {
	Reserve(context.Context, Binding, string) (bool, error)
	Settle(context.Context, Binding, Outcome) error
}

// Publication performs bounded in-memory publication under Authority's gate.
// Host/socket IO belongs to the separately authorized delivery composition.
// Any error after entry may follow a publication; it is UNKNOWN, never retried.
type Publication interface{ Publish(Binding, Outcome) error }

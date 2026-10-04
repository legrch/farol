// Package settingsdelivery owns pending Settings edit delivery policy only.
// It neither owns a settings database nor admits native effects.
package settingsdelivery

import "context"

// Selection carries the exact original preview identity from trusted root.
// Settings operation/profile/workspace/computer IDs must be lowercase UUIDv4.
// OwnerID is trusted composition identity and is not part of persisted pending.
type Selection struct {
	OperationID, OwnerID, ProfileID, ComputerID string
	ComputerGeneration                          uint64
}

// EditRequest is deliberately narrow. Root explicitly maps it into the sole
// owner engine's DTO; delivery owns neither a write operation nor another engine.
type EditRequest struct {
	WorkspaceID string
	Operation   Edit
}
type Edit struct {
	RelativePath   string
	Edits          []TextEdit
	ExpectedSHA256 string
}
type TextEdit struct{ OldText, NewText string }
type Observation struct{ WorkspaceID, RelativePath string }
type Response struct {
	OperationID, WorkspaceID string
	ComputerGeneration       uint64
	Phase, Publication       string
	Receipt                  *EffectReceipt
	Failure                  *Failure
}
type EffectReceipt struct {
	Operation, RelativePath string
	Bytes                   uint64
	Replacements            uint32
	BeforeSHA256            *string
	AfterSHA256             string
}
type Failure struct{ Code, Source string }

// Gate serializes this service. Ports execute under it and must not reenter.
type Gate interface {
	Lock()
	Unlock()
}

// Identity is selected by trusted composition. Generation is the current
// computer publication, not a replacement for the original pending generation.
type Identity struct {
	ProfileID, OwnerID, ComputerID string
	Generation                     uint64
}

// Pending persists correlation only. Edit text remains in a live Permit.
type Pending struct {
	Backend                                           string // Exactly go-owner-v2, matching the existing pending tuple.
	OperationID, ProfileID, WorkspaceID, RelativePath string
	ComputerGeneration                                uint64
	BeforeSHA256, SubmittedAt                         string // Raw SHA and injected UTC RFC3339 timestamp.
}

type Snapshot struct {
	Revision uint64
	Current  Identity
	Pending  *Pending
	// True only for verified=null, reachable=unknown, outcomeUnknown=true
	// and the fixed inspection/verification guidance, not merely verified=null.
	VerificationInvalidated bool
}

type Change struct {
	InvalidateVerification bool     // One-way request; never reverify or widen authority.
	Expected               Snapshot // Revision, current identity and exact previous pending.
	Next                   *Pending
}

type Publication uint8

const (
	Committed  Publication = iota + 1
	NotWritten             // Proven refusal before publication; no possible write.
	PublicationUnknown
)

type SaveResult struct {
	Publication Publication
	Readback    *Snapshot // Required only for Committed: exact durable readback.
}

// Store is a narrow mechanical CAS over the existing single configuration
// writer. It must preserve every unrelated value, and reject an expected-value
// mismatch before writing. Committed requires exact readback in the same call;
// error, lost reply or unproved refusal is PublicationUnknown, never NotWritten.
// Legacy/unrepresentable pending must be a Load error, never projected as nil.
// InvalidateVerification mechanically applies the exact one-way projection;
// Next=nil clears pending only and preserves the existing invalidation.
// Ports run under the supplied gate and must not reenter this service.
type Store interface {
	Load(context.Context) (Snapshot, error)
	CompareAndSet(context.Context, Change) (SaveResult, error)
}

// Outcomes delegates to the existing OwnerService/OwnerObserver. Selection and
// request are original values, never reconstructed edits or a renewed attempt.
// A missing record is nil/error and is treated as unknown. This foundation has
// no not_admitted seam: only a future exact live transport proof could add one.
type Outcomes interface {
	Execute(context.Context, Selection, EditRequest) (*Response, error)
	Observe(context.Context, Selection, Observation) (*Response, error)
}

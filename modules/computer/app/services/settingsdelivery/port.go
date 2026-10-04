// Package settingsdelivery owns pending Settings edit delivery policy only.
// It neither owns a settings database nor admits native effects.
package settingsdelivery

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/services/mutation"
)

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
	Execute(context.Context, mutation.OwnerSelection, mutation.OwnerRequest) (*mutation.OwnerResponse, error)
	Observe(context.Context, mutation.OwnerSelection, mutation.OwnerObservation) (*mutation.OwnerResponse, error)
}

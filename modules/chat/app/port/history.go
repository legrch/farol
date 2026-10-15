package port

import "context"

const HistoryPageSize = 32

// HistoryAnchor is an exact known Consume publication, selected by trusted
// composition only after its journal successor opens successfully. It is data
// used by the owning service's private capability, never a wire credential.
type HistoryAnchor struct {
	HeadDigest  [32]byte
	Consumption HandoffConsumption
}

// HistoryKey selects a previously completed turn, not an active handle. Profile
// and owner are pinned by the CURRENT read lease, never selected by the request.
type HistoryKey struct{ BackendGeneration, OperationID string }

// HistoryMatch joins an original completed turn to its accepted consumed
// ancestor. PreviousRevision belongs to that ancestor's original retirement.
// The whole immutable chain through Anchor must validate before any match is
// returned; matching orphan storage bytes cannot supply this evidence.
type HistoryMatch struct {
	Anchor           HistoryAnchor
	Origin           HandoffPublication
	PreviousRevision uint64
	Turn             RetirementTurn
}

// Page order is consumed-chain order, then the original retirement's sorted
// operation order. Offset counts only completed results owned by OwnerID.
// An immutable anchor keeps pagination stable. Entries is never nil, at most
// HistoryPageSize, and Total is bounded by MaxRetainedResults.
type HistoryPage struct {
	Anchor  HistoryAnchor
	Offset  uint32
	Total   uint32
	Entries []HistoryMatch
}

// HandoffHistoryStore is read-only lookup on the EXISTING handoff chain, not a
// second index or engine. The current head must exactly equal Anchor and remain
// SUCCESSOR_CONSUMED. Only consumed ancestors may yield completed results.
// A later empty cycle preserves earlier ancestors without copying old turns
// into the new live registry. Missing Find is nil,nil; malformed, incomplete,
// ambiguous, crossed, late or unknown reads return an error and no data.
type HandoffHistoryStore interface {
	HistoryPage(context.Context, HistoryAnchor, string, uint32) (*HistoryPage, error)
	HistoryFind(context.Context, HistoryAnchor, string, HistoryKey) (*HistoryMatch, error)
	// HistoryTail selects one exact owner/provider CID: the last matching consumed
	// ancestor, then its greatest original ReleasedRevision. Revisions are never
	// compared across ancestors. Missing is nil,nil; ties/contradictions refuse.
	HistoryTail(context.Context, HistoryAnchor, string, string) (*HistoryMatch, error)
}

// HistoryReadScope describes the current local reader. Its backend is the live
// successor, distinct from each original retained turn's backend and identity.
type HistoryReadScope struct{ ProfileID, BackendGeneration, OwnerID string }

// HistoryReadAuthority belongs to trusted composition. Native root metadata,
// old approval/admission, result IDs and a valid publication are not authority.
// The Desktop adapter may authorize only its current selected profile owner;
// it grants no workspace IO, model disclosure, Send, ACK, Follow or live handle.
type HistoryReadAuthority interface {
	AdmitHistoryRead(context.Context) (HistoryReadLease, error)
}

// WithCurrent calls inspect once under the current reader's gate, with no IO or
// owner reentry in the callback. A lease pins the original activation/lifetime;
// revoke/reactivate cannot make an old lease current. The service rechecks this
// same lease after every external read and before exposing retained content.
type HistoryReadLease interface {
	WithCurrent(context.Context, func(HistoryReadScope) error) error
}

// Package port defines Chat-owned lifecycle dependencies, not wire schemas.
package port

import (
	"context"

	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Gate serializes the entire current callback and all live state changes. Boot
// supplies a dedicated gate per owner. Lock/Unlock perform no native IO. Callers
// cannot reenter the owner or acquire Computer while holding this gate.
type Gate interface {
	Lock()
	Unlock()
}

// JournalScope is pinned by trusted boot, never a request-body incarnation.
// One fresh backend incarnation has exactly one owning journal writer.
type JournalScope struct {
	ProfileID, BackendGeneration string
}

type JournalHead struct {
	Scope    JournalScope
	Revision uint64
}

// JournalEntry is content-free transition evidence. Before/After are projections,
// not startup admission authority. IntentDigest appears only on initial admission;
// CallID retains resolved-call deduplication when replaying explicit transitions.
// Effect is empty or a narrow browser capability (prepare/send), never arbitrary IO.
// A pending effect remains in the journal until a second known settlement commit.
type JournalEntry struct {
	Binding                      TurnBinding
	Kind                         string
	Before, After                turn.Snapshot
	IntentDigest, CallID, Effect string
	Closed                       bool
}

type JournalWrite struct {
	Scope                      JournalScope
	PreviousRevision, Revision uint64
	Entry                      JournalEntry
}

type JournalReceipt struct {
	Write JournalWrite
}

// Journal creates an exclusively owned EMPTY journal for a fresh incarnation.
// OpenFresh must atomically refuse existing journals, including an empty journal
// already claimed by another owner. It must not load a cache as fresh authority.
// Commit is one atomic compare-and-swap append, with exact previous/next revision.
// Success means durable known publication of exactly Write; error/nil/mismatched
// receipt means uncertainty. The owner never retries, loads or compensates it.
// IO is bounded by ctx and always occurs outside Gate. A durable implementation
// must qualify atomicity/crash windows before boot uses it as admission proof.
type Journal interface {
	OpenFresh(context.Context, JournalScope) (*JournalHead, error)
	Commit(context.Context, JournalWrite) (*JournalReceipt, error)
}

// ResultRetention keeps transient delivery bytes outside journal/Activity.
// A successful receipt attests the exact unmodified payload, metadata and byte
// count held for delivery until the initiating client's explicit ACK. Reading/rendering is not that ACK.
// The adapter owns accepted storage/bounds; errors are never permission to retry.
type RetainRequest struct {
	Binding TurnBinding
	Result  turn.Result
	Payload []byte
}

type RetainReceipt struct {
	Binding TurnBinding
	Result  turn.Result
	Bytes   int
}

type ResultRetention interface {
	Retain(context.Context, RetainRequest) (*RetainReceipt, error)
}

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

// JournalRoot identifies the qualified physical profile root; it carries no path.
// Trusted boot pins this association before the live owner is constructed.
type JournalRoot struct {
	Device, Inode uint64
	OwnerUID      uint32
}

type JournalHead struct {
	Root     JournalRoot
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
	Quiescence                   turn.QuiescenceEvidence
	Disposal                     turn.DisposalEvidence
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
// OpenFresh refuses existing unresolved journals, including an empty journal
// already claimed by another owner. Only an explicitly origin-qualified clean
// successor constructor may replace known retirement with an EMPTY new scope.
// It must not load a cache as fresh admission authority.
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

// RetirementTurn retains original committed cleanup witnesses and the exact
// revisions of explicit delivery ACK and slot release. Booleans in Snapshot are
// projections and cannot replace these witnesses. An unreserved NOT_DISPATCHED
// cancellation needs no browser witness or release.
type RetirementTurn struct {
	Binding                                                 TurnBinding
	Snapshot                                                turn.Snapshot
	AcknowledgedRevision, SettledRevision, ReleasedRevision uint64
	Quiescence                                              turn.QuiescenceEvidence
	Disposal                                                turn.DisposalEvidence
}

type RetirementWrite struct {
	Scope                      JournalScope
	Root                       JournalRoot
	PreviousRevision, Revision uint64
	Turns                      []RetirementTurn
}

type RetirementReceipt struct {
	Write             RetirementWrite
	PublicationDigest [32]byte
}

// RetirementJournal publishes one atomic known retirement after exact clean
// evidence validation, then closes its owned native descriptors. Failure leaves
// the retained claim fenced. Retirement is one-shot, never a recovery API.
type RetirementJournal interface {
	Retire(context.Context, RetirementWrite) (*RetirementReceipt, error)
}

// CleanRetirement is an origin-qualified proof supplied by the actual retiring
// live owner, or trusted boot's retained known-clean receipt after that owner and
// its exact backend child terminated. It is NOT implemented by decoding disk
// history, a request DTO, retired=true, PID/time liveness or an unknown reply.
// WithRetirement makes exactly one synchronous callback with an independent
// value, under the origin's gate. No IO or owner reentry is allowed in callback;
// constructors copy it before doing physical qualification outside that gate.
// Boot owns cross-process proof retention and must preserve uncertain outcomes.
type CleanRetirement interface {
	WithRetirement(context.Context, func(*RetirementReceipt) error) error
}

func CopyRetirement(w RetirementWrite) RetirementWrite {
	if w.Turns != nil {
		w.Turns = append([]RetirementTurn{}, w.Turns...)
	}
	return w
}

func SameRetirement(a, b RetirementWrite) bool {
	if a.Scope != b.Scope || a.Root != b.Root || a.PreviousRevision != b.PreviousRevision || a.Revision != b.Revision || a.Turns == nil || b.Turns == nil || len(a.Turns) != len(b.Turns) {
		return false
	}
	for n := range a.Turns {
		if a.Turns[n] != b.Turns[n] {
			return false
		}
	}
	return true
}

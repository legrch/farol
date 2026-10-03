package port

import (
	"context"

	release "github.com/legrch/farol/modules/release/domain"
)

// JournalDirectory is measured descriptor identity, not a path or authority.
type JournalDirectory struct {
	Device       string
	Inode        string
	ParentDevice string
	ParentInode  string
}

// JournalAdmission is borrowed from the sole Release operation owner. It must
// hold accepted byte/profile provenance, the existing exclusion domain and
// complete stopped-writer/helper proof throughout the repository lifetime.
// Reverify is bounded and must not dispatch, probe a refused/unknown original
// helper, or infer quiescence from journal contents or spawn metadata.
//
// Unknown/RetainUnknown are synchronous local state in that same owner, shared
// by every repository consumer. Retention cannot be cleared by readback, Close,
// a new adapter, or caller cancellation. These methods perform no IO.
type JournalAdmission interface {
	// JournalGate returns the same borrowed gate for every consumer. It is a
	// local accessor, not a new lock domain; callbacks below never reenter it.
	JournalGate() StateGate
	ReverifyJournal(context.Context, release.Operation, JournalDirectory) error
	JournalUnknown(release.Operation) bool
	RetainJournalUnknown(release.Operation)
}

// JournalView reports a stable physical read only. Nil Value is confirmed
// absence at that observation; it does not settle retained uncertainty. Revision
// is an opaque CAS witness, never durable-success, helper-exit or startup proof.
type JournalView struct {
	Value    *release.Journal
	Revision string
}

// JournalRepository stores the existing alpha journal for one immutable full
// operation. CompareAndSwap success proves this call's completed persistence
// sequence only. The application owns phase transitions and dispatch policy.
// Close releases repository descriptors only, never the borrowed admission.
type JournalRepository interface {
	Read(context.Context) (*JournalView, error)
	CompareAndSwap(context.Context, string, release.Journal) (*JournalView, error)
	Close() error
}

type JournalCode string

func (c JournalCode) Error() string { return string(c) }

const (
	JournalInvalid     JournalCode = "UPDATE_JOURNAL_INPUT_INVALID"
	JournalPathInvalid JournalCode = "UPDATE_JOURNAL_PATH_INVALID"
	JournalUnavailable JournalCode = "UPDATE_JOURNAL_UNAVAILABLE"
	JournalChanged     JournalCode = "UPDATE_JOURNAL_CHANGED"
	JournalConflict    JournalCode = "UPDATE_JOURNAL_CONFLICT"
	JournalUnproven    JournalCode = "UPDATE_JOURNAL_ADMISSION_UNPROVEN"
	JournalCancelled   JournalCode = "UPDATE_JOURNAL_CANCELLED_BEFORE_WRITE"
	JournalClosed      JournalCode = "UPDATE_JOURNAL_CLOSED"
	JournalUnknown     JournalCode = "UPDATE_JOURNAL_PERSISTENCE_UNKNOWN"
)

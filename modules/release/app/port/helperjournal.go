package port

import (
	"context"

	release "github.com/legrch/farol/modules/release/domain"
)

// HelperJournalObservationAdmission borrows the original operation's gate and
// retained uncertainty for existing-only preflight. It deliberately does not
// implement JournalAdmission: no stopped-writer or exclusion proof is implied.
// Reverify checks actual route/slot custody and never reenters JournalGate.
type HelperJournalObservationAdmission interface {
	JournalGate() StateGate
	ReverifyHelperJournalObservation(context.Context, release.Operation, JournalDirectory) error
	JournalUnknown(release.Operation) bool
	RetainJournalUnknown(release.Operation)
}

// HelperJournalRepository borrows the existing operation journal and exclusion
// owner; it is not a second journal, admission source or recovery authority.
// Trusted composition retains the repository and its admission through the
// helper runtime's actual synchronous return, including cancellation.
type HelperJournalRepository interface {
	JournalRepository
	// ReadHelper preserves the original helper's 8192-byte input boundary.
	// It requires an original absolute context deadline, checks it independently
	// of timer delivery before native I/O and after actual return, and refuses
	// oversized input before parsing. The same directory/operation binding and
	// physical read checks apply as Read. An expired observation is not success.
	// It never writes, repairs, clears retained uncertainty or grants dispatch.
	ReadHelper(context.Context) (*JournalView, error)
}

package port

import "context"

// HelperInstallationRuntime extends the recovery port for admitted apply and
// rollback. Construction, parsed input and these values grant no authority:
// trusted composition retains the same real route/lease/slot/admission owner.
type HelperInstallationRuntime interface {
	HelperRecoveryRuntime
	// Prepare creates only the original prepared journal from confirmed absence
	// using the existing repository's original owner and CAS witness. An existing
	// record is never adopted, replaced or replayed, even if its values match.
	Prepare(context.Context) error
	// RejectTarget durably binds the fixed failed.app directory's measured
	// identity to this operation. Rejected bytes cannot attest as a target tree.
	RejectTarget(context.Context, HelperIdentity) error
}

// HelperTargetRejectionRepository writes the existing rejected-target.json for
// one immutable full operation. It borrows the exact operation directory and
// original JournalAdmission owner/gate through actual return, with no new lock,
// journal or startup authority. Expected identity is a comparison value only.
// The implementation rechecks the actual fixed owned failed.app directory,
// creates the record once without replacement, syncs and reads it back under
// the captured original deadline. Copies share one consumed attempt before
// I/O or cancellation; failed/unknown attempts never authorize another write.
// Persistence/cleanup uncertainty remains in that same owner's retained state
// across Close/readback/new consumers. Borrowed handles remain caller-owned.
type HelperTargetRejectionRepository interface {
	Record(context.Context, HelperIdentity) error
}

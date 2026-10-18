package port

import "context"

// HelperRecoveryPolicies is consumed by installation composition. Boot adapts
// the ORIGINAL recovery application owner, keeping service-to-service imports
// out of pure application packages. Neither factory supplies native admission.
type HelperRecoveryPolicies interface {
	Observe(context.Context, HelperRequest, HelperRecoveryObservation) (HelperRecoveryInspection, error)
	Bind(context.Context, HelperRequest, HelperRecoveryRuntime) (HelperRecoveryReconciliation, error)
}
type HelperRecoveryInspection interface{ Inspect(context.Context) error }
type HelperRecoveryReconciliation interface {
	Reconcile(context.Context) (string, error)
}

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

// HelperRecoveryObservation is the read-only part of the existing recovery
// runtime. A pre-ACK observer cannot obtain mutation, lock or journal authority
// by implementing this interface. Every method still requires physical custody.
type HelperRecoveryObservation interface {
	ReadPhase(context.Context) (string, error)
	Entries(context.Context) (HelperRecoveryEntries, error)
	MatchesTree(context.Context, HelperRecoveryEntry, HelperBuild) (bool, error)
	VerifyTree(context.Context, HelperRecoveryEntry, HelperBuild) error
}

// HelperJournalObservationReader is only the existing bounded physical reader.
// Composition must obtain it without weakening the original JournalAdmission.
// In particular a pre-ACK observation cannot manufacture a writer admission.
type HelperJournalObservationReader interface {
	ReadHelper(context.Context) (*JournalView, error)
}

// HelperInstallationObservation exposes no effect-capable repository. ReadJournal
// returns independent values from ReadHelper, including a confirmed-absence CAS
// witness. The witness is observational and never authorizes a write or retry.
type HelperInstallationObservation interface {
	HelperRecoveryObservation
	ReadJournal(context.Context) (*JournalView, error)
}

// HelperRelaunchEffects belongs to the SAME admitted native operation owner.
// CapturePrivateTarget must use actual held source/copy/tree/publication owners,
// preserve failed images, and independently verify the published private image.
// SelfIdentity measures this process, never input. LaunchTarget consumes one
// actual dispatch and joins the exact child Wait and all output producers. A
// returned path is correlation only; this owner retains the capture witness and
// must reject another path, substituted image, late result or unknown cleanup.
// Native composition retains the original deadline, routes and lease throughout.
// These ports declare required effects; they do not supply a launch capability.
type HelperRelaunchEffects interface {
	CapturePrivateTarget(context.Context) (string, error)
	SelfIdentity(context.Context) (HelperSelfIdentity, error)
	LaunchTarget(context.Context, HelperSelfIdentity, *string) error
}

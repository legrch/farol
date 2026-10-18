package lifecycle

import "errors"

// InspectionReason describes only the check that refused an inspection. It
// supplies no recovery, retry, ownership, admission or clean-retirement authority.
type InspectionReason string

const (
	InspectionUnspecified             InspectionReason = ""
	InspectionInputInvalid            InspectionReason = "input-invalid"
	InspectionCancelled               InspectionReason = "cancelled"
	InspectionSnapshotInvalid         InspectionReason = "snapshot-invalid"
	InspectionSnapshotRootMismatch    InspectionReason = "snapshot-root-mismatch"
	InspectionSnapshotProfileMismatch InspectionReason = "snapshot-profile-mismatch"
	InspectionRootInvalid             InspectionReason = "root-invalid"
	InspectionRootRoute               InspectionReason = "root-route"
	InspectionRootMetadata            InspectionReason = "root-metadata"
	InspectionRootIdentity            InspectionReason = "root-identity"
	InspectionClaimOpen               InspectionReason = "claim-open"
	InspectionClaimMetadata           InspectionReason = "claim-metadata"
	InspectionClaimLock               InspectionReason = "claim-lock"
	// ClaimRoute is the existing disk.check qualification of both named
	// root and claim. Its classified cause need not identify which failed.
	InspectionClaimRoute         InspectionReason = "claim-route"
	InspectionSnapshotRead       InspectionReason = "snapshot-read"
	InspectionSnapshotChanged    InspectionReason = "snapshot-changed"
	InspectionCleanupUnconfirmed InspectionReason = "cleanup-unconfirmed"
)

// InspectionFailure is constructed only by this adapter. The original Failure
// remains first in its error chain, preserving Code and OutcomeUnknown through
// errors.Is/As. Available private causes are retained without public formatting.
// In particular, claim-lock refusal does not prove that another owner is live.
type InspectionFailure struct {
	original *Failure
	reason   InspectionReason
	cause    error
}

func inspectionFailure(original *Failure, reason InspectionReason, causes ...error) *InspectionFailure {
	return &InspectionFailure{original: original, reason: reason, cause: errors.Join(causes...)}
}

func (f *InspectionFailure) Error() string {
	if f == nil || f.original == nil {
		return string(Unavailable)
	}
	return f.original.Error()
}

// Unwrap returns the original classification before any private causes. The
// returned slice cannot be used to replace either stored error.
func (f *InspectionFailure) Unwrap() []error {
	if f == nil {
		return nil
	}
	var result []error
	if f.original != nil {
		result = append(result, f.original)
	}
	if f.cause != nil {
		result = append(result, f.cause)
	}
	return result
}

func (f *InspectionFailure) Reason() InspectionReason {
	if f == nil || f.original == nil {
		return InspectionUnspecified
	}
	switch f.reason {
	case InspectionInputInvalid, InspectionCancelled, InspectionSnapshotInvalid,
		InspectionSnapshotRootMismatch, InspectionSnapshotProfileMismatch,
		InspectionRootInvalid, InspectionRootRoute, InspectionRootMetadata, InspectionRootIdentity,
		InspectionClaimOpen, InspectionClaimMetadata, InspectionClaimLock, InspectionClaimRoute,
		InspectionSnapshotRead, InspectionSnapshotChanged, InspectionCleanupUnconfirmed:
		return f.reason
	default:
		return InspectionUnspecified
	}
}

// InspectionReasonOf accepts only the exact constructed inspection wrapper.
// Opaque or joined errors never yield a nested, potentially optimistic reason.
func InspectionReasonOf(err error) InspectionReason {
	f, _ := err.(*InspectionFailure)
	return f.Reason()
}

// Called only after the existing synchronous disk.close reports an error. This
// changes neither its owner nor its calls, and retains both refusal and cleanup.
func inspectionCleanupFailure(original, closed error) *InspectionFailure {
	return inspectionFailure(&Failure{Code: Unavailable}, InspectionCleanupUnconfirmed, original, closed)
}

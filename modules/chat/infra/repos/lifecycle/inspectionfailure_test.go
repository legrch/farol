package lifecycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"syscall"
	"testing"
)

// Pure symbolic errors only. These tests exercise no files/descriptors and
// cannot prove a physical Close failure, native cleanup or lock ownership.
func TestInspectionDiagnosticOriginalClassificationAndPrivateCauses(t *testing.T) {
	for _, code := range []Code{Invalid, Refused, Unavailable, Unknown, Cancelled} {
		for _, unknown := range []bool{false, true} {
			original := &Failure{Code: code, OutcomeUnknown: unknown}
			native := &os.PathError{Op: "read", Path: "/synthetic/private-journal", Err: syscall.EACCES}
			decode := errors.New("synthetic private decode content")
			err := inspectionFailure(original, InspectionSnapshotRead, native, decode)
			var classified *Failure
			if !errors.As(err, &classified) || classified != original || classified.Code != code || classified.OutcomeUnknown != unknown || !errors.Is(err, code) || !errors.Is(err, original) {
				t.Fatal("original classification changed")
			}
			var cause *os.PathError
			if !errors.As(err, &cause) || cause != native || !errors.Is(err, syscall.EACCES) || !errors.Is(err, decode) {
				t.Fatal("available private cause lost")
			}
			if err.Error() != string(code) || fmt.Sprint(err) != string(code) || fmt.Sprintf("%+v", err) != string(code) || InspectionReasonOf(err) != InspectionSnapshotRead {
				t.Fatal("public error changed or private content escaped")
			}
			serialized, marshalErr := json.Marshal(err)
			if marshalErr != nil || string(serialized) != "{}" {
				t.Fatal("diagnostic private fields became serialized", marshalErr)
			}
			chain := err.Unwrap()
			chain[0] = nil
			if !errors.Is(err, original) {
				t.Fatal("caller replaced stored classification through unwrap slice")
			}
		}
	}
}

func TestInspectionDiagnosticReasonRequiresExactWrapper(t *testing.T) {
	original := &Failure{Code: Refused}
	exact := inspectionFailure(original, InspectionSnapshotRootMismatch)
	if InspectionReasonOf(exact) != InspectionSnapshotRootMismatch {
		t.Fatal("exact constructed reason missing")
	}
	for _, err := range []error{nil, original, fmt.Errorf("opaque: %w", exact), errors.Join(exact), errors.Join(errors.New("opaque"), exact)} {
		if InspectionReasonOf(err) != InspectionUnspecified {
			t.Fatal("searched an opaque/joined error for a nested reason")
		}
	}
	invalid := inspectionFailure(original, InspectionReason("synthetic-private-unrecognized-reason"))
	if invalid.Reason() != InspectionUnspecified || invalid.Error() != string(Refused) {
		t.Fatal("reason vocabulary is open")
	}
}

func TestInspectionDiagnosticNilZeroAndTypedNilAreSafe(t *testing.T) {
	for _, value := range []*InspectionFailure{nil, {}, inspectionFailure(nil, InspectionSnapshotRead)} {
		var err error = value
		if err.Error() != string(Unavailable) || value.Reason() != InspectionUnspecified || InspectionReasonOf(err) != InspectionUnspecified || len(value.Unwrap()) != 0 {
			t.Fatal("nil/zero diagnostic is unsafe or supplies a reason")
		}
		var original *Failure
		if errors.Is(err, Refused) || errors.As(err, &original) {
			t.Fatal("nil/zero diagnostic invented an original failure")
		}
		var wrapped *InspectionFailure
		if !errors.As(err, &wrapped) || wrapped != value {
			t.Fatal("typed-nil wrapper could not be inspected safely")
		}
	}
}

func TestInspectionDiagnosticCleanupRetainsRefusalAndSuppliedCloseCauses(t *testing.T) {
	// Symbolic close errors test aggregation only, never a real OS Close failure.
	claimClose := &os.PathError{Op: "close", Path: "/synthetic/claim", Err: syscall.EIO}
	rootClose := errors.New("synthetic root close failure")
	closed := errors.Join(claimClose, rootClose)
	for _, original := range []error{nil, inspectionFailure(&Failure{Code: Refused}, InspectionClaimLock, syscall.EWOULDBLOCK)} {
		err := inspectionCleanupFailure(original, closed)
		var classified *Failure
		if !errors.As(err, &classified) || classified.Code != Unavailable || classified.OutcomeUnknown || err.Error() != string(Unavailable) || InspectionReasonOf(err) != InspectionCleanupUnconfirmed {
			t.Fatal("cleanup changed its original public refusal")
		}
		if !errors.Is(err, closed) || !errors.Is(err, claimClose) || !errors.Is(err, syscall.EIO) || !errors.Is(err, rootClose) {
			t.Fatal("actual supplied cleanup causes lost")
		}
		if original != nil && (!errors.Is(err, original) || !errors.Is(err, Refused) || !errors.Is(err, syscall.EWOULDBLOCK)) {
			t.Fatal("original inspection refusal lost during cleanup")
		}
	}
}

func TestInspectionDiagnosticClassifiedReadCauseStaysOriginal(t *testing.T) {
	// disk.read can return a classified failure without the original syscall.
	// The outer inspection keeps its original Unavailable/false classification.
	read := &Failure{Code: Unavailable, OutcomeUnknown: true}
	original := &Failure{Code: Unavailable}
	err := inspectionFailure(original, InspectionSnapshotRead, read)
	var classified *Failure
	if !errors.As(err, &classified) || classified != original || classified.OutcomeUnknown || !errors.Is(err, read) || !read.OutcomeUnknown || errors.Is(err, syscall.EIO) {
		t.Fatal("classified read was replaced or missing syscall provenance invented")
	}
}

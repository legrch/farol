package apptree

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestVerificationRefusalDoesNotDowngradeDependencyFailures(t *testing.T) {
	policy := errors.New("inspected pure policy refusal")
	classify := func(err error) bool { return err == policy }
	known := &Error{Code: CodeDigest}
	for _, err := range []error{known, &observationFailure{refusal: &Error{Code: CodeIdentity}, cause: policy}} {
		if !IsVerificationRefusal(err, classify) {
			t.Fatal("inspected refusal was lost")
		}
	}
	for _, err := range []error{nil, (*Error)(nil), &Error{Code: CodeIO}, &Error{Code: CodeInput}, &Error{Code: CodeCanceled}, &Error{Code: "unknown"}, context.Canceled, fmt.Errorf("opaque: %w", known), errors.Join(known, errors.New("native cleanup")), &observationFailure{refusal: known, cause: policy}, &observationFailure{refusal: &Error{Code: CodeIdentity}, cause: errors.Join(policy, errors.New("I/O"))}, &observationFailure{refusal: &Error{Code: CodeIdentity}, cause: policy, cancellation: context.Canceled}} {
		if IsVerificationRefusal(err, classify) {
			t.Fatal("dependency/cancellation/unknown failure downgraded", err)
		}
	}
}

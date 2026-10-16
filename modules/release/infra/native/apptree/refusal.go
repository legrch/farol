package apptree

// IsVerificationRefusal recognizes only this verifier's own inspected negative
// observations. An opaque wrapper, I/O error, cancellation or joined failure
// never becomes a negative match. Trusted composition may classify the exact
// pure identity-policy cause; it must not classify host or cleanup failures.
func IsVerificationRefusal(err error, identityRefusal func(error) bool) bool {
	switch e := err.(type) {
	case *Error:
		if e == nil {
			return false
		}
		switch e.Code {
		case CodeChanged, CodeType, CodeName, CodeLimit, CodeLink, CodeDigest, CodeIdentity:
			return true
		}
	case *observationFailure:
		return e != nil && e.refusal != nil && e.refusal.Code == CodeIdentity &&
			e.cancellation == nil && e.cause != nil && identityRefusal != nil && identityRefusal(e.cause)
	}
	return false
}

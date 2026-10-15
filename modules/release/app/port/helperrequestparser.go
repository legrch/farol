package port

import "context"

// HelperRequestParser reuses the existing helper-input application owner through
// a consumer-owned port. Parse has no effects, returns independent values and
// exposes only its closed input/acceptance/canceled/unavailable error codes.
// Trusted composition supplies a non-panicking, non-typed-nil implementation.
type HelperRequestParser interface {
	Parse(context.Context, []byte) (HelperRequest, error)
}

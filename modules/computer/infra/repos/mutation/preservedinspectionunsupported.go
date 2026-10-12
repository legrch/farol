//go:build !darwin

package mutation

import "context"

func inspectPreservedExisting(context.Context, Root, []ExpectedPreservedRecord, func(PreservedInspection) error) (*PreservedInspection, error) {
	return nil, unavailable()
}

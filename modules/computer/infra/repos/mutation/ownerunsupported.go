//go:build !darwin

package mutation

import "context"

func inspectOwnerExisting(context.Context, Root, []ExpectedOwnerRecord, func(OwnerInspection) error) (*OwnerInspection, error) {
	return nil, unavailable()
}

//go:build !darwin

package mutation

import "context"

func inspectSettledExisting(context.Context, Root, [settledRecordCount]ExpectedSettledRecord, func(SettledInspection) error) (*SettledInspection, error) {
	return nil, unavailable()
}

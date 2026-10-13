//go:build !darwin

package mutation

import "context"

func InspectPreservedAfterMachineRestart(context.Context, Root, SettledSelection, []ExpectedPreservedRecord, string, func(PreservedInspection) error) (*PreservedInspection, error) {
	return nil, unavailable()
}

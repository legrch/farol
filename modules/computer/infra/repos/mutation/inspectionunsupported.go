//go:build !darwin

package mutation

import "context"

func inspectEmptyExisting(context.Context, Root) (*EmptyInspection, error) {
	return nil, unavailable()
}

func withClosedEmptyInspection(context.Context, Root, func(EmptyInspection) error) error {
	return unavailable()
}

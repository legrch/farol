//go:build !darwin

package mutation

import "context"

func inspectEmptyExisting(context.Context, Root) (*EmptyInspection, error) {
	return nil, unavailable()
}

//go:build !darwin && !linux

package lifecycle

import "context"

func inspectClosedSnapshot(context.Context, Root, Limits) (*Inspection, error) {
	return nil, failure(Unavailable, false)
}

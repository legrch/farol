//go:build !darwin && !linux

package handoff

import "context"

func openDisk(context.Context, Roots) (storage, error) { return nil, fail(Unavailable, false) }

//go:build !darwin && !linux

package boot

import (
	"context"
	"errors"
)

type freshSession struct{ root NativeRoot }

func acquireFreshSession(context.Context, NativeRoot, string) (*freshSession, error) {
	return nil, errors.New("FRESH_SESSION_UNSUPPORTED")
}
func (*freshSession) verify() error { return errors.New("FRESH_SESSION_UNSUPPORTED") }
func (*freshSession) close() error  { return nil }

//go:build !darwin

package codex

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

type unavailableBoundary struct{}

func NativeBoundary() Boundary                                      { return unavailableBoundary{} }
func (unavailableBoundary) Verify(context.Context, Selection) error { return task.ErrUnavailable }
func (unavailableBoundary) Launch(context.Context, Selection) (Process, error) {
	return nil, task.ErrUnavailable
}

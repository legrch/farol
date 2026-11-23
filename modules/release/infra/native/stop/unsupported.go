//go:build !darwin

package stop

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

type nativeSystem struct{}

func (nativeSystem) path(context.Context, int) (string, error) { return "", ErrUnsupported }
func (nativeSystem) signal(int, port.ProcessSignal) error      { return ErrUnsupported }

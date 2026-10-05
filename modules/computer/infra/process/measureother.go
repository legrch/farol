//go:build !darwin

package process

import (
	"context"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func measureLaunch(context.Context, Command, *confinedLaunch) (func(), error) {
	return nil, &processsvc.NativeFailure{}
}

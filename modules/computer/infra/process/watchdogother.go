//go:build !darwin

package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type nativeWatchdogHost struct{}

func (nativeWatchdogHost) Start(context.Context, WatchdogSelection, string) (watchdogProcess, watchdogChannel, error) {
	return nil, nil, &processsvc.NativeFailure{}
}

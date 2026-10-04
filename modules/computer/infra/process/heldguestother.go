//go:build !darwin

package process

import (
	"context"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func RunHeldGuest(context.Context, Command, Command, *NativeQualification, time.Time, <-chan struct{}, <-chan struct{}, func(context.Context) error, func() error) error {
	return &processsvc.NativeFailure{}
}

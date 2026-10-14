//go:build !darwin

package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func recheckPythonAlias(context.Context, *pythonAliasMeasurement) error {
	return &processsvc.NativeFailure{}
}

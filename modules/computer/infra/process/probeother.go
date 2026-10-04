//go:build !darwin

package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

type systemProbe struct{}

func (systemProbe) CurrentProcess() int                           { return 0 }
func (systemProbe) Allowed(context.Context, string, string) error { return &processsvc.NativeFailure{} }
func (systemProbe) DeniedRead(context.Context, string) error      { return &processsvc.NativeFailure{} }
func (systemProbe) DeniedWrite(context.Context, string) error     { return &processsvc.NativeFailure{} }
func (systemProbe) DeniedConnect(context.Context, string) error   { return &processsvc.NativeFailure{} }

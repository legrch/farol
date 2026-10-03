//go:build !darwin

package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"io"
	"os"
	"os/exec"
)

func configure(*exec.Cmd) error         { return &processsvc.NativeFailure{} }
func exitDetails(*os.ProcessState) exit { return exit{} }

type nativeBoundary struct{ qualification Qualification }

func (nativeBoundary) Start(context.Context, Command, func(context.Context) error, io.Writer, io.Writer) (owned, error) {
	return nil, &processsvc.NativeFailure{}
}

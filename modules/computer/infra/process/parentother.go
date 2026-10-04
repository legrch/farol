//go:build !darwin

package process

import (
	"os/exec"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func waitAnchor(*exec.Cmd) (exit, error) { return exit{}, &processsvc.NativeFailure{Unknown: true} }

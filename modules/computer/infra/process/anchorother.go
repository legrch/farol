//go:build !darwin

package process

import (
	"context"
	"os/exec"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func ownAnchorGroup() (anchorStop, error) { return nil, &processsvc.NativeFailure{} }
func observeHeld(context.Context, *exec.Cmd, HeldGate) (trackedGuest, error) {
	return nil, &processsvc.NativeFailure{Unknown: true}
}

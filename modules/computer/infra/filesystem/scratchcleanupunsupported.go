//go:build !darwin

package filesystem

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
)

func (*Mutable) RemoveEmptyScratch(context.Context, port.ScratchCleanupRequest) error {
	return refusal("WORKSPACE_PATH_REFUSED")
}

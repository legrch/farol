//go:build !darwin

package filesystem

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
)

// Unsupported platforms do not perform a staging effect.
func (*Mutable) CreateStagedScratch(context.Context, port.MutationRequest, int, port.Root) (*port.MutationReceipt, error) {
	return nil, refusal("WORKSPACE_PATH_REFUSED")
}

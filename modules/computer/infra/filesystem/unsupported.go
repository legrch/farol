//go:build !darwin

package filesystem

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
)

// No weak rename fallback or non-Darwin native mutation qualification exists.
func nativeMutationFS() mutationFS { return nil }

func (*Mutable) RemoveEmptyScratch(context.Context, port.ScratchCleanupRequest) error {
	return refusal("WORKSPACE_PATH_REFUSED")
}

// Unsupported platforms do not perform a staging effect.
func (*Mutable) CreateStagedScratch(context.Context, port.MutationRequest, int, port.Root) (*port.MutationReceipt, error) {
	return nil, refusal("WORKSPACE_PATH_REFUSED")
}

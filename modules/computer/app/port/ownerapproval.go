package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CurrentOwnerApproval is bound by trusted composition to one exact owner and
// publication. Caller identifiers never select authority. WithCurrent holds the
// current authority locks, invokes inspect exactly once synchronously with an
// independent approval snapshot, and propagates its error. A nil snapshot means
// withdrawn approval. Neither the snapshot nor its children may be mutated until
// WithCurrent returns. inspect must not mutate/reenter the owner. Only the
// MutationRequest.WithPublication callback may perform one workspace-parent mkdir
// or final file publication/verification/guarded undo; preparation and journal IO stay outside.
type CurrentOwnerApproval interface {
	WithCurrent(context.Context, func(*authority.Approval) error) error
}

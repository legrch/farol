package port

import (
	"context"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"time"
)

// AccessSnapshot is a coherent participant/approval view, never two separately
// awaited snapshots. Missing participant and approval remain distinct facts.
type AccessSnapshot struct {
	Participant *authority.Participant
	Approval    *authority.Approval
}

// AccessRepository serializes the callback with every grant/approval mutation.
// It calls inspect exactly once while the snapshot remains current, and passes
// independent values. inspect is synchronous and must not modify/reenter this
// repository. Only MutationRequest.WithPublication may run one workspace-parent
// mkdir or final file publication/verification/guarded undo inside inspect;
// other IO stays outside.
// Disclosure admission and response construction finish
// inside inspect; a later revocation does not retract already admitted bytes.
// An unavailable store returns a classified failure; it never looks absent.
type AccessRepository interface {
	WithSnapshot(context.Context, string, func(AccessSnapshot) error) error
}
type Clock interface{ Now() time.Time }

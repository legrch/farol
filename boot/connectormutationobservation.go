package boot

import (
	"context"
	"strings"

	"github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// One ordinary READ lease protects a retained receipt lookup. It is unrelated
// to the original write lease and cannot dispatch another mutation. The trusted
// root selects this live connector and stable profile before any request lookup.
type connectorMutationObservation struct {
	profile, owner, computer string
	lease                    mutationsvc.Execution
	clock                    port.Clock
}

func (s *computerConnector) mutationObservation(ctx context.Context, slot *connectorSlot) (*connectorMutationObservation, error) {
	if s == nil || s.root == nil || slot == nil || slot.route == nil || slot.route.issuer == nil {
		return nil, computerUnavailable()
	}
	lease, err := slot.route.admit(ctx, authority.Read)
	if err != nil {
		return nil, err
	}
	return &connectorMutationObservation{profile: s.root.peer.ProfileId, owner: s.root.ownerID,
		computer: s.root.computerID, lease: lease, clock: s.clock}, nil
}

func (s *connectorMutationObservation) WithMutationObservation(ctx context.Context, identity state.Identity, workspace, path string, inspect func() error) error {
	if s == nil || s.lease == nil || s.clock == nil || ctx == nil || ctx.Err() != nil || inspect == nil ||
		!state.ValidIdentity(identity) || identity.Scope != state.ScopeConnector || identity.OwnerID != s.owner ||
		identity.ProfileID != s.profile || identity.ComputerID != s.computer || !validIngressID(workspace) || !state.RelativePath(path) {
		return authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	b := s.lease.Binding()
	if b.OwnerID != s.owner {
		return authority.Fail("AUTHORITY_OWNER_MISMATCH", "task-grant")
	}
	calls := 0
	var inspected error
	err := s.lease.WithSnapshot(ctx, b.ParticipantID, func(snapshot port.AccessSnapshot) error {
		calls++
		reject := func(err error) error { inspected = err; return err }
		if calls != 1 {
			return reject(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
		}
		now := s.clock.Now()
		if ctx.Err() != nil || !now.Before(s.lease.Deadline()) {
			return reject(authority.Fail("AUTHORITY_EXPIRED", "task-grant"))
		}
		p, a := snapshot.Participant, snapshot.Approval
		if p == nil || a == nil || p.ParticipantID != b.ParticipantID || p.Grant.ComputerID != s.computer || a.ComputerID != s.computer {
			return reject(authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
		}
		scope, ok := authority.FindScope(p.Grant, workspace)
		if !ok || !authority.CanonicalPath(scope.Root) {
			return reject(authority.Fail("AUTHORITY_PATH_DENIED", "task-grant"))
		}
		action := authority.Action{Identity: b.Identity, Operation: authority.Operation{Kind: authority.Read,
			WorkspaceID: workspace, Path: strings.TrimSuffix(scope.Root, "/") + "/" + path}}
		if err := authority.AuthorizeComputer(p.Clone(), a.Clone(), action, now); err != nil {
			return reject(err)
		}
		return reject(inspect())
	})
	if err != nil {
		return err
	}
	if calls != 1 {
		return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	if ctx.Err() != nil {
		return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	return inspected
}

var _ port.CurrentMutationObservation = (*connectorMutationObservation)(nil)

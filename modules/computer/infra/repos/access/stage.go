package access

import (
	"context"
	"reflect"

	"github.com/legrch/farol/modules/computer/domain/authority"
	transition "github.com/legrch/farol/modules/computer/domain/journal"
)

// StageContinuityApproval is a narrow protected snapshot CAS for the original
// WAL's already-confirmed publish intent. It returns no admission capability
// and leaves the journal pending. A separate certificate and current native
// qualification must precede any boot publication/activation.
func (s *Store) StageContinuityApproval(ctx context.Context, id string, planned transition.Receipt, revision uint64, proposed authority.Approval) (Status, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return Status{}, err
	}
	entry, ok := s.journal.Find(id)
	if !s.journalPresent || !ok || entry.Phase != transition.PublishIntent || entry.Publication != planned ||
		!validApproval(proposed, s.binding) || s.current.Approval == nil {
		return Status{}, unavailable()
	}
	old := *s.current.Approval
	selectedRoot := ""
	for _, w := range old.Workspaces {
		if w.WorkspaceID == entry.Request.WorkspaceID {
			selectedRoot = w.Root
		}
	}
	if selectedRoot == "" || entry.Request.Root != selectedRoot {
		return Status{}, unavailable()
	}
	if proposed.Generation != old.Generation+1 || !sameStableEffectiveLimits(old, proposed, entry.Request.WorkspaceID) {
		return Status{}, unavailable()
	}
	n, err := s.nextState(revision)
	if err != nil {
		return Status{}, err
	}
	now, err := s.now()
	if err != nil {
		return Status{}, err
	}
	if now.After(proposed.ExpiresAt) {
		return Status{}, authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	proposal := approval(proposed)
	n.Approval = &proposal
	n.Generation = proposal.Generation
	n.SeenApproval = true
	// Prior participant/task/agent grants never survive a new current native
	// binding. Preserve their audit identity but revoke their effective use.
	for id, participant := range n.Participants {
		participant.Revoked = true
		n.Participants[id] = participant
	}
	// Store's protected write, fsync/readback and publicationUnknown poison stay
	// unchanged; journal remains in publish_intent even after these bytes land.
	if err := s.commit(ctx, n); err != nil {
		return Status{}, err
	}
	return Status{Revision: s.current.Revision, Generation: s.current.Generation, ApprovalPresent: true}, nil
}

func sameStableEffectiveLimits(before, after authority.Approval, selected string) bool {
	if before.OwnerID != after.OwnerID || before.ComputerID != after.ComputerID || before.Network != after.Network ||
		before.FilePolicy != after.FilePolicy || after.ExpiresAt.After(before.ExpiresAt) || len(before.Workspaces) != len(after.Workspaces) ||
		!reflect.DeepEqual(before.ExcludedPaths, after.ExcludedPaths) {
		return false
	}
	// After native rebind, previous ShellVerified is NOT durable consent. Refuse
	// any shell presence until fresh current Setup/build/generation checks.
	selectedCount := 0
	for i, a := range after.Workspaces {
		b := before.Workspaces[i]
		if a.WorkspaceID == selected {
			selectedCount++
		} else if a.RootIdentity != b.RootIdentity {
			// A continuity operation may rebind only its original selected root.
			return false
		}
		if a.WorkspaceID != b.WorkspaceID || a.Root != b.Root || a.Access != b.Access ||
			!reflect.DeepEqual(a.GitMetadata, b.GitMetadata) || a.GitHistoryApproved != b.GitHistoryApproved || a.ShellVerified ||
			a.RootIdentity.Inode != b.RootIdentity.Inode {
			return false
		}
	}
	// The current effective projection may only LOSE readiness/capabilities;
	// its owner-granted scope cannot be widened here.
	rank := func(c authority.Commands) int {
		switch c {
		case authority.NoCommands:
			return 0
		case authority.VerificationCommands:
			return 1
		case authority.WorkspaceCommands:
			return 2
		default:
			return 99
		}
	}
	if selectedCount != 1 || rank(after.Commands) > rank(before.Commands) {
		return false
	}
	oldCapabilities := map[authority.Capability]bool{}
	for _, c := range before.Capabilities {
		oldCapabilities[c] = true
	}
	for _, c := range after.Capabilities {
		if !oldCapabilities[c] || c == authority.Shell {
			return false
		}
	}
	return true
}

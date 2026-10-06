package process

import (
	"slices"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// rootScopedScopes projects the SAME current owner/task authority into the kernel
// profile. Additional workspace/toolchain/Git roots must already be present on
// both sides. A cwd, argv, symlink target, Git common dir or approval *request*
// cannot manufacture a grant here. No filesystem IO or approval occurs here.
func rootScopedScopes(s SeatbeltSelection, command Command) ([]authority.Scope, error) {
	refuse := func() ([]authority.Scope, error) { return nil, &processsvc.NativeFailure{} }
	p, a := s.Snapshot.Participant, s.Snapshot.Approval
	if p == nil || a == nil || len(p.Grant.Workspaces) == 0 || len(p.Grant.Workspaces) > 64 {
		return refuse()
	}
	seen := map[string]bool{}
	out := make([]authority.Scope, 0, len(p.Grant.Workspaces))
	for _, scope := range p.Grant.Workspaces {
		if seen[scope.WorkspaceID] || !bindingID(scope.WorkspaceID) {
			return refuse()
		}
		seen[scope.WorkspaceID] = true
		var approved authority.ApprovedWorkspace
		matches := 0
		for _, candidate := range a.Workspaces {
			if candidate.WorkspaceID == scope.WorkspaceID {
				approved = candidate
				matches++
			}
		}
		if matches != 1 || !approved.ShellVerified || !absolutePolicyPath(approved.Root) || !absolutePolicyPath(scope.Root) ||
			approved.RootIdentity.Device == "" || approved.RootIdentity.Inode == "" || !insidePolicy(approved.Root, scope.Root) ||
			scope.Mode != authority.Subtree || len(scope.Paths) != 0 || comparableOverlap(scope.Root, s.Scratch) ||
			(scope.Access != authority.ReadAccess && scope.Access != authority.WriteAccess) ||
			(approved.Access != authority.ReadAccess && approved.Access != authority.WriteAccess) {
			return refuse()
		}
		// An invocation's read-only selection narrows EVERY root, not only cwd.
		if !command.Write || scope.Access != authority.WriteAccess || approved.Access != authority.WriteAccess {
			scope.Access = authority.ReadAccess
		}
		out = append(out, scope)
	}
	// Old explicit restrictions must be replaced by an owner-approved policy
	// transition, not dropped by choosing this compiler. Check cross-workspace
	// overlap too: a broad HOME grant cannot defeat an excluded nested workspace.
	for _, exclusion := range slices.Concat(a.ExcludedPaths, p.Grant.ExcludedPaths) {
		if !absolutePolicyPath(exclusion.Path) {
			return refuse()
		}
		for _, scope := range out {
			if exclusion.WorkspaceID == scope.WorkspaceID || comparableOverlap(exclusion.Path, scope.Root) {
				return refuse()
			}
		}
	}
	return out, nil
}

func seatbeltNetworkAllowed(s SeatbeltSelection) bool {
	if s.Network == authority.NoNetwork {
		return true
	}
	p, a := s.Snapshot.Participant, s.Snapshot.Approval
	return s.FilePolicy == authority.RootScopedFiles && s.Network == authority.ApprovedNetwork && p != nil && a != nil &&
		p.Grant.Network == authority.ApprovedNetwork && a.Network == authority.ApprovedNetwork &&
		slices.Contains(p.Grant.Capabilities, authority.NetworkUse) && slices.Contains(a.Capabilities, authority.NetworkUse)
}

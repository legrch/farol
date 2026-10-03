package authority

import "time"

func capabilitiesInclude(parent, child []Capability) bool {
	for _, requested := range child {
		switch requested {
		case List, Read, Search, Verify, Write, Shell:
		default:
			return false
		}
		found := false
		for _, available := range parent {
			if requested == available {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func networkIncludes(parent, child Network) bool {
	return (parent == NoNetwork || parent == ApprovedNetwork) && (child == NoNetwork || child == ApprovedNetwork) && (parent == ApprovedNetwork || child == NoNetwork)
}
func commandsInclude(parent, child Commands) bool {
	if parent != NoCommands && parent != VerificationCommands && parent != WorkspaceCommands {
		return false
	}
	return child == NoCommands || child == parent || (parent == WorkspaceCommands && child == VerificationCommands)
}
func approvalPolicy(a Approval) Policy {
	scopes := make([]Scope, len(a.Workspaces))
	for i, workspace := range a.Workspaces {
		scopes[i] = Scope{WorkspaceID: workspace.WorkspaceID, Root: workspace.Root, Mode: Subtree, Access: workspace.Access}
	}
	return Policy{Workspaces: scopes, ExcludedPaths: a.ExcludedPaths, Capabilities: a.Capabilities, Network: a.Network, Commands: a.Commands, ExpiresAt: a.ExpiresAt}
}
func Derive(a Approval, admission Admission, now time.Time) (*Grant, error) {
	if a.OwnerID != admission.OwnerID {
		return nil, fail("AUTHORITY_OWNER_MISMATCH", ComputerApprovalSource)
	}
	if a.ComputerID != admission.ComputerID || a.Generation != admission.ComputerGeneration {
		return nil, fail("AUTHORITY_COMPUTER_MISMATCH", ComputerApprovalSource)
	}
	if now.After(a.ExpiresAt) || now.After(admission.ExpiresAt) {
		return nil, fail("AUTHORITY_EXPIRED", TaskAdmissionSource)
	}
	if !exclusionsValid(approvalPolicy(a).Workspaces, a.ExcludedPaths) {
		return nil, fail("AUTHORITY_INFLATION_DENIED", ComputerApprovalSource)
	}
	if admission.ExpiresAt.After(a.ExpiresAt) || !capabilitiesInclude(a.Capabilities, admission.Capabilities) || !networkIncludes(a.Network, admission.Network) || !commandsInclude(a.Commands, admission.Commands) || !scopesSubset(approvalPolicy(a).Workspaces, admission.Workspaces) || !exclusionsValid(admission.Workspaces, admission.ExcludedPaths) {
		return nil, fail("AUTHORITY_INFLATION_DENIED", TaskAdmissionSource)
	}
	p := clonePolicy(admission.Policy)
	for i := range p.Workspaces {
		p.Workspaces[i].RestrictionSource = TaskGrantSource
	}
	p.ExcludedPaths = merge(relevant(p.Workspaces, a.ExcludedPaths, ComputerApprovalSource), relevant(p.Workspaces, admission.ExcludedPaths, TaskGrantSource))
	if len(p.ExcludedPaths) > 32 {
		return nil, fail("AUTHORITY_INFLATION_DENIED", TaskAdmissionSource)
	}
	return &Grant{Identity: admission.Identity, AuthorityID: admission.AuthorityID, ComputerID: admission.ComputerID, ComputerGeneration: admission.ComputerGeneration, Policy: p}, nil
}
func validParticipant(a ParticipantAdmission) bool {
	return (a.Role == Main || a.Role == Agent || a.Role == Critic) && (a.MutationOwnership == NoOwnership || a.MutationOwnership == TaskOwnership)
}
func Create(g Grant, admission ParticipantAdmission) (*Participant, error) {
	if !validParticipant(admission) || (admission.MutationOwnership == TaskOwnership && !capabilitiesInclude(g.Capabilities, []Capability{Write})) {
		return nil, Fail("AUTHORITY_INFLATION_DENIED", "role")
	}
	return &Participant{ParticipantID: admission.ParticipantID, Role: admission.Role, MutationOwnership: admission.MutationOwnership, Grant: g.Clone()}, nil
}
func Narrow(g Grant, n Narrowing) (*Grant, error) {
	if !capabilitiesInclude(g.Capabilities, n.Capabilities) || !networkIncludes(g.Network, n.Network) || !commandsInclude(g.Commands, n.Commands) || !scopesSubset(g.Workspaces, n.Workspaces) || !exclusionsValid(n.Workspaces, n.ExcludedPaths) {
		return nil, fail("AUTHORITY_INFLATION_DENIED", OwnerRestrictionSource)
	}
	out := g.Clone()
	out.Workspaces = cloneScopes(n.Workspaces)
	for i := range out.Workspaces {
		out.Workspaces[i].RestrictionSource = OwnerRestrictionSource
	}
	var inherited []Exclusion
	for _, exclusion := range g.ExcludedPaths {
		for _, scope := range n.Workspaces {
			if affects(exclusion, scope) {
				inherited = append(inherited, exclusion)
				break
			}
		}
	}
	out.ExcludedPaths = merge(inherited, relevant(n.Workspaces, n.ExcludedPaths, OwnerRestrictionSource))
	if len(out.ExcludedPaths) > 32 {
		return nil, fail("AUTHORITY_INFLATION_DENIED", OwnerRestrictionSource)
	}
	out.Capabilities = append([]Capability(nil), n.Capabilities...)
	out.Network = n.Network
	out.Commands = n.Commands
	return &out, nil
}
func Delegate(parent Participant, admission Delegation) (*Participant, error) {
	if admission.MutationOwnership == TaskOwnership && parent.MutationOwnership != TaskOwnership {
		return nil, Fail("AUTHORITY_INFLATION_DENIED", "role")
	}
	g := parent.Grant.Clone()
	if admission.Narrowing != nil {
		narrowed, err := Narrow(g, *admission.Narrowing)
		if err != nil {
			return nil, err
		}
		g = *narrowed
	}
	out, err := Create(g, admission.ParticipantAdmission)
	if err != nil {
		return nil, err
	}
	out.ParentParticipantID = parent.ParticipantID
	return out, nil
}

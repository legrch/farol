package authority

// NoAccess describes an explicit empty policy, not a missing or revoked grant.
// Identity, generation, expiry and current consent still require their normal
// admission checks. This policy cannot authorize filesystem or process effects.
func (p Policy) NoAccess() bool {
	return len(p.Workspaces) == 0 && len(p.ExcludedPaths) == 0 &&
		len(p.Capabilities) == 0 && p.Network == NoNetwork && p.Commands == NoCommands
}

func (a Approval) NoAccess() bool { return approvalPolicy(a).NoAccess() }

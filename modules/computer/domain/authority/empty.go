package authority

// NoAccess identifies a retained explicit empty policy, never missing consent.
// It grants no filesystem, process or network capability. Identity, generation,
// expiry and revocation remain subject to their existing checks.
func (p Policy) NoAccess() bool {
	return len(p.Workspaces) == 0 && len(p.ExcludedPaths) == 0 &&
		len(p.Capabilities) == 0 && p.Network == NoNetwork && p.Commands == NoCommands
}

func (a Approval) NoAccess() bool { return approvalPolicy(a).NoAccess() }

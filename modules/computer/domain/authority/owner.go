package authority

import (
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// AuthorizeOwnerList authorizes only an owner Settings directory listing under
// a trusted current approval. It creates no participant, task, turn or grant.
func AuthorizeOwnerList(a Approval, workspaceID, path string, now time.Time) error {
	if !ownerIdentifier(a.OwnerID, 80) || !ownerIdentifier(a.ComputerID, 120) || !ownerApprovalValid(a) {
		return fail("COMPUTER_APPROVAL_INVALID", ComputerApprovalSource)
	}
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(a.ExpiresAt) {
		return fail("AUTHORITY_EXPIRED", ComputerApprovalSource)
	}
	if !ownerIdentifier(workspaceID, 120) || !ownerPath(path, true) {
		return fail("COMPUTER_PATH_INVALID", ComputerApprovalSource)
	}
	return authorizePolicy(approvalPolicy(a), Action{Operation: Operation{Kind: List, WorkspaceID: workspaceID, Path: path}}, now, string(ComputerApprovalSource))
}

func ownerApprovalValid(a Approval) bool {
	ms := a.ExpiresAt.UnixMilli()
	if ms <= 0 || ms > 9007199254740991 || !a.ExpiresAt.Equal(time.UnixMilli(ms)) ||
		len(a.Workspaces) == 0 || len(a.Workspaces) > 32 || len(a.Capabilities) > 7 ||
		!networkIncludes(a.Network, a.Network) || !commandsInclude(a.Commands, a.Commands) {
		return false
	}
	capabilities := map[Capability]bool{}
	for _, c := range a.Capabilities {
		if capabilities[c] || !capabilitiesInclude([]Capability{c}, []Capability{c}) {
			return false
		}
		capabilities[c] = true
	}
	ids := map[string]bool{}
	for _, w := range a.Workspaces {
		if !ownerIdentifier(w.WorkspaceID, 120) || ids[w.WorkspaceID] || !ownerPath(w.Root, true) || w.Root == "/" ||
			!accessIncludes(w.Access, w.Access) || !ownerCounter(w.RootIdentity.Device) || !ownerCounter(w.RootIdentity.Inode) {
			return false
		}
		ids[w.WorkspaceID] = true
		if w.GitMetadata != nil && (!ownerPath(w.GitMetadata.GitDirectory, true) || !ownerPath(w.GitMetadata.CommonDirectory, true)) {
			return false
		}
	}
	if !exclusionsValid(approvalPolicy(a).Workspaces, a.ExcludedPaths) {
		return false
	}
	for _, e := range a.ExcludedPaths {
		if !ownerPath(e.Path, true) {
			return false
		}
		switch e.RestrictionSource {
		case "", ComputerApprovalSource, TaskAdmissionSource, TaskGrantSource, OwnerRestrictionSource, UnknownSource:
		default:
			return false
		}
	}
	return true
}

func ownerIdentifier(v string, max int) bool {
	if v == "" || !utf8.ValidString(v) {
		return false
	}
	units := 0
	for _, r := range v {
		if r < 32 || r == 127 {
			return false
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	return units <= max
}

func ownerCounter(v string) bool {
	if v == "" || len(v) > 20 {
		return false
	}
	for _, r := range v {
		if r < '0' || r > '9' {
			return false
		}
	}
	_, err := strconv.ParseUint(v, 10, 64)
	return err == nil
}

// Match the existing native component grammar without consulting the host.
func ownerPath(v string, absolute bool) bool {
	if !utf8.ValidString(v) || v == "" || len(v) > 4096 || strings.Contains(v, "\\") || strings.HasPrefix(v, "/") != absolute {
		return false
	}
	if absolute {
		v = v[1:]
	}
	parts := strings.Split(v, "/")
	if len(parts) > 256 {
		return false
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || len(p) > 255 {
			return false
		}
		for _, r := range p {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}

package authority

import (
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// AuthorizeOwnerList authorizes only an owner Settings directory listing under
// a trusted current approval. It creates no participant, task, turn or grant.
func AuthorizeOwnerList(a Approval, workspaceID, path string, now time.Time) error {
	return authorizeOwner(a, workspaceID, path, now, List)
}

// AuthorizeOwnerRead authorizes only an owner Settings file read under a trusted
// current approval. List capability confers no read authority.
func AuthorizeOwnerRead(a Approval, workspaceID, path string, now time.Time) error {
	return authorizeOwner(a, workspaceID, path, now, Read)
}

// AuthorizeOwnerSearch requires explicit Search capability under the current
// owner Settings approval. Read/List authority never grants search authority.
func AuthorizeOwnerSearch(a Approval, workspaceID, path string, now time.Time) error {
	return authorizeOwner(a, workspaceID, path, now, Search)
}

// AuthorizeOwnerWrite requires both the explicit write capability and write
// workspace access. Read/List authority never implies permission to mutate.
func AuthorizeOwnerWrite(a Approval, workspaceID, path string, now time.Time) error {
	return authorizeOwner(a, workspaceID, path, now, Write)
}

func authorizeOwner(a Approval, workspaceID, path string, now time.Time, capability Capability) error {
	if !ownerIdentifier(a.OwnerID, 80) || !ownerIdentifier(a.ComputerID, 120) || !ownerApprovalValid(a) {
		return fail("COMPUTER_APPROVAL_INVALID", ComputerApprovalSource)
	}
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(a.ExpiresAt) {
		return fail("AUTHORITY_EXPIRED", ComputerApprovalSource)
	}
	if !ownerIdentifier(workspaceID, 120) || !ownerPath(path, true) {
		return fail("COMPUTER_PATH_INVALID", ComputerApprovalSource)
	}
	return authorizePolicy(approvalPolicy(a), Action{Operation: Operation{Kind: capability, WorkspaceID: workspaceID, Path: path, Write: capability == Write}}, now, string(ComputerApprovalSource))
}

func ownerApprovalValid(a Approval) bool {
	ms := a.ExpiresAt.UnixMilli()
	if !a.FilePolicy.Valid() || ms <= 0 || ms > 9007199254740991 || !a.ExpiresAt.Equal(time.UnixMilli(ms)) ||
		len(a.Workspaces) > 32 || len(a.Capabilities) > 7 ||
		!networkIncludes(a.Network, a.Network) || !commandsInclude(a.Commands, a.Commands) {
		return false
	}
	if len(a.Workspaces) == 0 {
		return a.Generation > 0 && a.NoAccess()
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

// ReadOnlyWorkspaceWrite reports whether the owner's Read only access setting
// for one workspace is the sole reason the approval refuses a file write at
// relativePath. It holds only when the current approval refuses the write and
// the same approval, with exactly that workspace switched to Read & write,
// admits it: a path outside the root, an excluded path, an invalid approval or
// any other refusal stays unclassified. Expiry is not part of the question, so
// the structural check runs inside the approval's own lifetime.
//
// It is a pure explanation of a refusal that already happened. It grants,
// stores and retries nothing; callers keep the original code and never act on
// the upgraded approval.
func ReadOnlyWorkspaceWrite(a Approval, workspaceID, relativePath string) bool {
	if !ownerPath(relativePath, false) {
		return false
	}
	index := slices.IndexFunc(a.Workspaces, func(w ApprovedWorkspace) bool { return w.WorkspaceID == workspaceID })
	if index < 0 || a.Workspaces[index].Access != ReadAccess {
		return false
	}
	at := a.ExpiresAt.Add(-time.Millisecond)
	path := strings.TrimSuffix(a.Workspaces[index].Root, "/") + "/" + relativePath
	if AuthorizeOwnerWrite(a, workspaceID, path, at) == nil {
		return false
	}
	upgraded := a.Clone()
	upgraded.Workspaces[index].Access = WriteAccess
	if !slices.Contains(upgraded.Capabilities, Write) {
		// Owner consent derives Write exactly when one workspace is writable.
		upgraded.Capabilities = append(upgraded.Capabilities, Write)
	}
	return AuthorizeOwnerWrite(upgraded, workspaceID, path, at) == nil
}

// WriteRefusalReason returns the closed workspace_read_only explanation for err
// only when err is the refused write authority code that the approval's Read
// only setting for workspaceID alone explains. Otherwise it returns "": every
// other refusal, an unknown outcome and an unclassified error stay plain.
func WriteRefusalReason(err error, a Approval, workspaceID, relativePath string) string {
	var f *Failure
	if !errors.As(err, &f) || (f.Code != "AUTHORITY_CAPABILITY_DENIED" && f.Code != "AUTHORITY_PATH_DENIED") || !ReadOnlyWorkspaceWrite(a, workspaceID, relativePath) {
		return ""
	}
	return "workspace_read_only"
}

package access

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// The private snapshot is not a wire protocol or a replacement journal. It
// retains the existing authority values, including revoked identities, as one
// bounded current view. Counters are lossless decimal strings; expiry is the
// existing positive, safe Unix millisecond value.
const maxStateBytes = 1024 * 1024
const maxParticipants = 256

type Binding struct{ ProfileID, OwnerID, ComputerID string }
type state struct {
	Revision     uint64
	Generation   uint64
	SeenApproval bool
	Approval     *authority.Approval
	Participants map[string]retainedParticipant
}
type retainedParticipant struct {
	Value   authority.Participant
	Revoked bool
}
type document struct {
	Schema       int                         `json:"schema"`
	ProfileID    string                      `json:"profileId"`
	OwnerID      string                      `json:"ownerId"`
	ComputerID   string                      `json:"computerId"`
	Revision     string                      `json:"revision"`
	Generation   string                      `json:"generation"`
	SeenApproval bool                        `json:"seenApproval"`
	Approval     *approvalValue              `json:"approval"`
	Participants map[string]participantValue `json:"participants"`
}
type rootValue struct {
	Device string `json:"device"`
	Inode  string `json:"inode"`
}
type gitValue struct {
	GitDirectory    string `json:"gitDirectory"`
	CommonDirectory string `json:"commonDirectory"`
}
type workspaceValue struct {
	WorkspaceID        string           `json:"workspaceId"`
	Root               string           `json:"root"`
	Access             authority.Access `json:"access"`
	RootIdentity       rootValue        `json:"rootIdentity"`
	GitMetadata        *gitValue        `json:"gitMetadata,omitempty"`
	GitHistoryApproved bool             `json:"gitHistoryApproved"`
	ShellVerified      bool             `json:"shellVerified"`
}
type scopeValue struct {
	WorkspaceID       string           `json:"workspaceId"`
	Root              string           `json:"root"`
	Mode              authority.Mode   `json:"mode"`
	Paths             []string         `json:"paths"`
	Access            authority.Access `json:"access"`
	RestrictionSource authority.Source `json:"restrictionSource"`
}
type exclusionValue struct {
	WorkspaceID       string           `json:"workspaceId"`
	Path              string           `json:"path"`
	RestrictionSource authority.Source `json:"restrictionSource"`
}
type policyValue struct {
	Workspaces    []scopeValue           `json:"workspaces"`
	ExcludedPaths []exclusionValue       `json:"excludedPaths"`
	Capabilities  []authority.Capability `json:"capabilities"`
	Network       authority.Network      `json:"network"`
	Commands      authority.Commands     `json:"commands"`
	ExpiresAt     int64                  `json:"expiresAt"`
}
type approvalValue struct {
	OwnerID       string                 `json:"ownerId"`
	ComputerID    string                 `json:"computerId"`
	Generation    string                 `json:"generation"`
	Workspaces    []workspaceValue       `json:"workspaces"`
	ExcludedPaths []exclusionValue       `json:"excludedPaths"`
	Capabilities  []authority.Capability `json:"capabilities"`
	Network       authority.Network      `json:"network"`
	Commands      authority.Commands     `json:"commands"`
	ExpiresAt     int64                  `json:"expiresAt"`
}
type participantValue struct {
	ParticipantID       string              `json:"participantId"`
	ParentParticipantID string              `json:"parentParticipantId"`
	Role                authority.Role      `json:"role"`
	MutationOwnership   authority.Ownership `json:"mutationOwnership"`
	AuthorityID         string              `json:"authorityId"`
	OwnerID             string              `json:"ownerId"`
	SessionID           string              `json:"sessionId"`
	TaskID              string              `json:"taskId"`
	TaskEpoch           string              `json:"taskEpoch"`
	ComputerID          string              `json:"computerId"`
	ComputerGeneration  string              `json:"computerGeneration"`
	Policy              policyValue         `json:"policy"`
	Revoked             bool                `json:"revoked"`
}

func decimal(v uint64) string { return strconv.FormatUint(v, 10) }
func counter(v string) (uint64, error) {
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil || decimal(n) != v {
		return 0, unavailable()
	}
	return n, nil
}
func encodeExclusions(in []authority.Exclusion) []exclusionValue {
	out := make([]exclusionValue, len(in))
	for i, v := range in {
		out[i] = exclusionValue{v.WorkspaceID, v.Path, v.RestrictionSource}
	}
	return out
}
func decodeExclusions(in []exclusionValue) []authority.Exclusion {
	out := make([]authority.Exclusion, len(in))
	for i, v := range in {
		out[i] = authority.Exclusion{WorkspaceID: v.WorkspaceID, Path: v.Path, RestrictionSource: v.RestrictionSource}
	}
	return out
}
func encodePolicy(p authority.Policy) policyValue {
	v := policyValue{Workspaces: make([]scopeValue, len(p.Workspaces)), ExcludedPaths: encodeExclusions(p.ExcludedPaths), Capabilities: p.Capabilities, Network: p.Network, Commands: p.Commands, ExpiresAt: p.ExpiresAt.UnixMilli()}
	for i, s := range p.Workspaces {
		v.Workspaces[i] = scopeValue{s.WorkspaceID, s.Root, s.Mode, s.Paths, s.Access, s.RestrictionSource}
	}
	return v
}
func decodePolicy(v policyValue) authority.Policy {
	p := authority.Policy{Workspaces: make([]authority.Scope, len(v.Workspaces)), ExcludedPaths: decodeExclusions(v.ExcludedPaths), Capabilities: v.Capabilities, Network: v.Network, Commands: v.Commands, ExpiresAt: time.UnixMilli(v.ExpiresAt)}
	for i, s := range v.Workspaces {
		p.Workspaces[i] = authority.Scope{WorkspaceID: s.WorkspaceID, Root: s.Root, Mode: s.Mode, Paths: s.Paths, Access: s.Access, RestrictionSource: s.RestrictionSource}
	}
	return p
}
func encodeApproval(a authority.Approval) *approvalValue {
	v := &approvalValue{OwnerID: a.OwnerID, ComputerID: a.ComputerID, Generation: decimal(a.Generation), Workspaces: make([]workspaceValue, len(a.Workspaces)), ExcludedPaths: encodeExclusions(a.ExcludedPaths), Capabilities: a.Capabilities, Network: a.Network, Commands: a.Commands, ExpiresAt: a.ExpiresAt.UnixMilli()}
	for i, w := range a.Workspaces {
		v.Workspaces[i] = workspaceValue{WorkspaceID: w.WorkspaceID, Root: w.Root, Access: w.Access, RootIdentity: rootValue{w.RootIdentity.Device, w.RootIdentity.Inode}, GitHistoryApproved: w.GitHistoryApproved, ShellVerified: w.ShellVerified}
		if w.GitMetadata != nil {
			v.Workspaces[i].GitMetadata = &gitValue{w.GitMetadata.GitDirectory, w.GitMetadata.CommonDirectory}
		}
	}
	return v
}
func decodeApproval(v *approvalValue) (*authority.Approval, error) {
	if v == nil {
		return nil, nil
	}
	gen, err := counter(v.Generation)
	if err != nil {
		return nil, err
	}
	a := &authority.Approval{OwnerID: v.OwnerID, ComputerID: v.ComputerID, Generation: gen, Workspaces: make([]authority.ApprovedWorkspace, len(v.Workspaces)), ExcludedPaths: decodeExclusions(v.ExcludedPaths), Capabilities: v.Capabilities, Network: v.Network, Commands: v.Commands, ExpiresAt: time.UnixMilli(v.ExpiresAt)}
	for i, w := range v.Workspaces {
		a.Workspaces[i] = authority.ApprovedWorkspace{WorkspaceID: w.WorkspaceID, Root: w.Root, Access: w.Access, RootIdentity: authority.RootIdentity{Device: w.RootIdentity.Device, Inode: w.RootIdentity.Inode}, GitHistoryApproved: w.GitHistoryApproved, ShellVerified: w.ShellVerified}
		if w.GitMetadata != nil {
			a.Workspaces[i].GitMetadata = &authority.GitMetadata{GitDirectory: w.GitMetadata.GitDirectory, CommonDirectory: w.GitMetadata.CommonDirectory}
		}
	}
	return a, nil
}
func encodeParticipant(p authority.Participant, revoked bool) participantValue {
	g := p.Grant
	return participantValue{ParticipantID: p.ParticipantID, ParentParticipantID: p.ParentParticipantID, Role: p.Role, MutationOwnership: p.MutationOwnership, AuthorityID: g.AuthorityID, OwnerID: g.OwnerID, SessionID: g.SessionID, TaskID: g.TaskID, TaskEpoch: decimal(g.TaskEpoch), ComputerID: g.ComputerID, ComputerGeneration: decimal(g.ComputerGeneration), Policy: encodePolicy(g.Policy), Revoked: revoked}
}

func encodeState(b Binding, s state) ([]byte, error) {
	d := document{Schema: 1, ProfileID: b.ProfileID, OwnerID: b.OwnerID, ComputerID: b.ComputerID, Revision: decimal(s.Revision), Generation: decimal(s.Generation), SeenApproval: s.SeenApproval, Participants: map[string]participantValue{}}
	if s.Approval != nil {
		d.Approval = encodeApproval(*s.Approval)
	}
	for id, r := range s.Participants {
		d.Participants[id] = encodeParticipant(r.Value, r.Revoked)
	}
	raw, err := json.Marshal(d)
	if err != nil || len(raw)+1 > maxStateBytes {
		return nil, unavailable()
	}
	return append(raw, '\n'), nil
}
func decodeState(b Binding, raw []byte) (state, error) {
	s := state{Participants: map[string]retainedParticipant{}}
	var d document
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if len(raw) > maxStateBytes || dec.Decode(&d) != nil || d.Schema != 1 || d.ProfileID != b.ProfileID || d.OwnerID != b.OwnerID || d.ComputerID != b.ComputerID || d.Participants == nil || len(d.Participants) > maxParticipants {
		return s, unavailable()
	}
	var err error
	if s.Revision, err = counter(d.Revision); err != nil {
		return s, err
	}
	if s.Generation, err = counter(d.Generation); err != nil {
		return s, err
	}
	s.SeenApproval = d.SeenApproval
	if s.Approval, err = decodeApproval(d.Approval); err != nil {
		return s, err
	}
	if !s.SeenApproval && (s.Generation != 0 || s.Approval != nil || len(d.Participants) != 0) {
		return s, unavailable()
	}
	if s.Approval != nil && (!validApproval(*s.Approval, b) || s.Approval.Generation != s.Generation) {
		return s, unavailable()
	}
	for id, v := range d.Participants {
		epoch, err := counter(v.TaskEpoch)
		if err != nil {
			return s, err
		}
		gen, err := counter(v.ComputerGeneration)
		if err != nil {
			return s, err
		}
		p := authority.Participant{ParticipantID: v.ParticipantID, ParentParticipantID: v.ParentParticipantID, Role: v.Role, MutationOwnership: v.MutationOwnership, Grant: authority.Grant{Identity: authority.Identity{OwnerID: v.OwnerID, SessionID: v.SessionID, TaskID: v.TaskID, TaskEpoch: epoch}, AuthorityID: v.AuthorityID, ComputerID: v.ComputerID, ComputerGeneration: gen, Policy: decodePolicy(v.Policy)}}
		if id != p.ParticipantID || !validParticipant(p, b) || gen > s.Generation {
			return s, unavailable()
		}
		s.Participants[id] = retainedParticipant{p, v.Revoked}
	}
	// This format has exactly one canonical encoding. Unknown, duplicate, missing,
	// differently cased keys and trailing data cannot become trusted state.
	canonical, err := encodeState(b, s)
	if err != nil || !bytes.Equal(canonical, raw) {
		return s, unavailable()
	}
	for id, r := range s.Participants {
		seen := map[string]bool{id: true}
		p := r.Value
		for p.ParentParticipantID != "" {
			parent, ok := s.Participants[p.ParentParticipantID]
			if !ok || seen[p.ParentParticipantID] || (!r.Revoked && parent.Revoked) || parent.Value.Grant.Identity != r.Value.Grant.Identity || parent.Value.Grant.AuthorityID != r.Value.Grant.AuthorityID {
				return s, unavailable()
			}
			child := p
			ceiling := parent.Value
			if child.Grant.ComputerGeneration != ceiling.Grant.ComputerGeneration || child.Grant.ComputerID != ceiling.Grant.ComputerID || child.Grant.ExpiresAt.After(ceiling.Grant.ExpiresAt) {
				return s, unavailable()
			}
			narrowed, err := authority.Delegate(ceiling, authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: child.ParticipantID, Role: child.Role, MutationOwnership: child.MutationOwnership}, Narrowing: &authority.Narrowing{Workspaces: child.Grant.Workspaces, ExcludedPaths: child.Grant.ExcludedPaths, Capabilities: child.Grant.Capabilities, Network: child.Grant.Network, Commands: child.Grant.Commands}})
			if err != nil {
				return s, unavailable()
			}
			for _, required := range narrowed.Grant.ExcludedPaths {
				found := false
				for _, actual := range child.Grant.ExcludedPaths {
					if actual.WorkspaceID == required.WorkspaceID && actual.Path == required.Path {
						found = true
						break
					}
				}
				if !found {
					return s, unavailable()
				}
			}
			seen[p.ParentParticipantID] = true
			p = parent.Value
		}
	}
	return s, nil
}
func identifier(v string, max int) bool {
	if v == "" || len([]rune(v)) > max || !utf8.ValidString(v) {
		return false
	}
	for _, r := range v {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validBinding(b Binding) bool {
	return identifier(b.ProfileID, 120) && identifier(b.OwnerID, 80) && identifier(b.ComputerID, 120)
}
func absolute(v string) bool {
	if len(v) <= 1 || len(v) > 4096 || !authority.CanonicalPath(v) || !utf8.ValidString(v) {
		return false
	}
	for _, p := range strings.Split(v[1:], "/") {
		if len(p) > 255 {
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
func expiry(v time.Time) bool {
	ms := v.UnixMilli()
	return ms > 0 && ms <= 9007199254740991 && v.Equal(time.UnixMilli(ms))
}
func source(v authority.Source) bool {
	return v == "" || v == authority.ComputerApprovalSource || v == authority.TaskAdmissionSource || v == authority.TaskGrantSource || v == authority.OwnerRestrictionSource || v == authority.UnknownSource
}
func exclusions(v []authority.Exclusion) bool {
	if len(v) > 32 {
		return false
	}
	for _, e := range v {
		if !identifier(e.WorkspaceID, 120) || !absolute(e.Path) || !source(e.RestrictionSource) {
			return false
		}
	}
	return true
}
func permissions(c []authority.Capability, n authority.Network, cmd authority.Commands) bool {
	if len(c) == 0 || len(c) > 7 || (n != authority.NoNetwork && n != authority.ApprovedNetwork) || (cmd != authority.NoCommands && cmd != authority.VerificationCommands && cmd != authority.WorkspaceCommands) {
		return false
	}
	seen := map[authority.Capability]bool{}
	for _, v := range c {
		switch v {
		case authority.List, authority.Read, authority.Search, authority.Verify, authority.Write, authority.Shell:
		default:
			return false
		}
		if seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}
func validPolicy(p authority.Policy) bool {
	if len(p.Workspaces) == 0 || len(p.Workspaces) > 32 || !exclusions(p.ExcludedPaths) || !permissions(p.Capabilities, p.Network, p.Commands) || !expiry(p.ExpiresAt) {
		return false
	}
	seen := map[string]bool{}
	for _, s := range p.Workspaces {
		if !identifier(s.WorkspaceID, 120) || seen[s.WorkspaceID] || !absolute(s.Root) || (s.Access != authority.ReadAccess && s.Access != authority.WriteAccess) || !source(s.RestrictionSource) {
			return false
		}
		seen[s.WorkspaceID] = true
		switch s.Mode {
		case authority.Subtree:
			if len(s.Paths) != 0 {
				return false
			}
		case authority.Exact:
			if len(s.Paths) == 0 || len(s.Paths) > 500 {
				return false
			}
			for _, p := range s.Paths {
				if !absolute(p) || !authority.Within(s.Root, p) {
					return false
				}
			}
		default:
			return false
		}
	}
	_, err := authority.Narrow(authority.Grant{Policy: p}, authority.Narrowing{Workspaces: p.Workspaces, ExcludedPaths: p.ExcludedPaths, Capabilities: p.Capabilities, Network: p.Network, Commands: p.Commands})
	return err == nil
}
func validApproval(a authority.Approval, b Binding) bool {
	if a.OwnerID != b.OwnerID || a.ComputerID != b.ComputerID || len(a.Workspaces) == 0 || len(a.Workspaces) > 32 || !exclusions(a.ExcludedPaths) || !permissions(a.Capabilities, a.Network, a.Commands) || !expiry(a.ExpiresAt) {
		return false
	}
	seen := map[string]bool{}
	for _, w := range a.Workspaces {
		if !identifier(w.WorkspaceID, 120) || seen[w.WorkspaceID] || !absolute(w.Root) || (w.Access != authority.ReadAccess && w.Access != authority.WriteAccess) {
			return false
		}
		seen[w.WorkspaceID] = true
		for _, v := range []string{w.RootIdentity.Device, w.RootIdentity.Inode} {
			if _, err := counter(v); err != nil {
				return false
			}
		}
		if w.GitMetadata != nil && (!absolute(w.GitMetadata.GitDirectory) || !absolute(w.GitMetadata.CommonDirectory)) {
			return false
		}
	}
	// Reuse the existing domain check for exclusion and approval scope validity.
	scopes := make([]authority.Scope, len(a.Workspaces))
	for i, w := range a.Workspaces {
		scopes[i] = authority.Scope{WorkspaceID: w.WorkspaceID, Root: w.Root, Mode: authority.Subtree, Access: w.Access}
	}
	_, err := authority.Derive(a, authority.Admission{Identity: authority.Identity{OwnerID: b.OwnerID, SessionID: "validation", TaskID: "validation"}, AuthorityID: "validation", ComputerID: b.ComputerID, ComputerGeneration: a.Generation, Policy: authority.Policy{Workspaces: scopes, ExcludedPaths: a.ExcludedPaths, Capabilities: a.Capabilities, Network: a.Network, Commands: a.Commands, ExpiresAt: a.ExpiresAt}}, time.UnixMilli(1))
	return err == nil
}
func validParticipant(p authority.Participant, b Binding) bool {
	g := p.Grant
	if !identifier(p.ParticipantID, 120) || (p.ParentParticipantID != "" && !identifier(p.ParentParticipantID, 120)) || g.OwnerID != b.OwnerID || g.ComputerID != b.ComputerID || !identifier(g.SessionID, 120) || !identifier(g.TaskID, 120) || !identifier(g.AuthorityID, 120) || !validPolicy(g.Policy) {
		return false
	}
	_, err := authority.Create(g, authority.ParticipantAdmission{ParticipantID: p.ParticipantID, Role: p.Role, MutationOwnership: p.MutationOwnership})
	return err == nil
}
func unavailable() *authority.Failure {
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}
func invalid() *authority.Failure {
	return authority.Fail("AUTHORITY_INFLATION_DENIED", "task-admission")
}

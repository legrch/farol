package authority

import (
	"slices"
	"time"
)

const TaskGrantLifetime = 12 * time.Hour
const OrdinaryExecutionLifetime = 15 * time.Second
const VerificationExecutionLifetime = 120 * time.Second

// Reissue derives through the existing policy mechanism. Only the admitted
// ceiling's expiry changes; current owner approval independently bounds it.
func Reissue(a Approval, ceiling Admission, now time.Time, lifetime time.Duration) (*Grant, error) {
	deadline, err := lifetimeDeadline(a, now, lifetime)
	if err != nil {
		return nil, err
	}
	ceiling.Policy = clonePolicy(ceiling.Policy)
	ceiling.ExpiresAt = deadline
	return Derive(a, ceiling, now)
}
func lifetimeDeadline(a Approval, now time.Time, lifetime time.Duration) (time.Time, error) {
	const maxMillis = int64(9007199254740991)
	ms := now.UnixMilli()
	if ms <= 0 || ms > maxMillis || lifetime <= 0 || lifetime%time.Millisecond != 0 || lifetime.Milliseconds() > maxMillis-ms {
		return time.Time{}, fail("AUTHORITY_EXPIRED", TaskAdmissionSource)
	}
	deadline := now.Add(lifetime)
	if a.ExpiresAt.Before(deadline) {
		deadline = a.ExpiresAt
	}
	if !now.Before(deadline) {
		return time.Time{}, fail("AUTHORITY_EXPIRED", TaskAdmissionSource)
	}
	return deadline, nil
}

// ExecutionLease is a value owned by one admitted operation. Its snapshot and
// deadline are private, independent copies; outer grant reissue cannot modify it.
type ExecutionLease struct {
	participant Participant
	deadline    time.Time
}

// Call only after a fresh outer grant has been admitted under current policy.
// The outer expiry gates admission; execution has its own fixed deadline.
func Lease(p Participant, a Approval, now time.Time, lifetime time.Duration) (*ExecutionLease, error) {
	if !p.Grant.FilePolicy.Valid() || !a.FilePolicy.Valid() || p.Grant.FilePolicy != a.FilePolicy || p.Grant.ComputerID != a.ComputerID || p.Grant.ComputerGeneration != a.Generation {
		return nil, fail("AUTHORITY_COMPUTER_MISMATCH", ComputerApprovalSource)
	}
	if now.After(p.Grant.ExpiresAt) {
		return nil, fail("AUTHORITY_EXPIRED", TaskAdmissionSource)
	}
	deadline, err := lifetimeDeadline(a, now, lifetime)
	if err != nil {
		return nil, err
	}
	p = p.Clone()
	p.Grant.ExpiresAt = deadline
	return &ExecutionLease{participant: p, deadline: deadline}, nil
}
func (l ExecutionLease) Deadline() time.Time      { return l.deadline }
func (l ExecutionLease) Participant() Participant { return l.participant.Clone() }
func (l ExecutionLease) Check(now time.Time) error {
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(l.deadline) {
		return fail("AUTHORITY_EXPIRED", TaskGrantSource)
	}
	return nil
}
func (p Participant) Clone() Participant { p.Grant = p.Grant.Clone(); return p }
func (a Approval) Clone() Approval {
	a.Workspaces = slices.Clone(a.Workspaces)
	for i := range a.Workspaces {
		if a.Workspaces[i].GitMetadata != nil {
			metadata := *a.Workspaces[i].GitMetadata
			a.Workspaces[i].GitMetadata = &metadata
		}
	}
	a.ExcludedPaths = slices.Clone(a.ExcludedPaths)
	a.Capabilities = slices.Clone(a.Capabilities)
	return a
}

// Policy comparisons ignore expiry alone. Ordering and restriction provenance
// remain part of the sealed ceiling; nil and empty collections are equivalent.
func SameApprovalPolicy(a, b Approval) bool {
	return a.OwnerID == b.OwnerID && a.ComputerID == b.ComputerID &&
		a.Generation == b.Generation && a.FilePolicy == b.FilePolicy && a.Network == b.Network && a.Commands == b.Commands &&
		slices.Equal(a.Capabilities, b.Capabilities) && slices.Equal(a.ExcludedPaths, b.ExcludedPaths) &&
		slices.EqualFunc(a.Workspaces, b.Workspaces, func(a, b ApprovedWorkspace) bool {
			metadata := a.GitMetadata == nil && b.GitMetadata == nil || a.GitMetadata != nil && b.GitMetadata != nil && *a.GitMetadata == *b.GitMetadata
			a.GitMetadata, b.GitMetadata = nil, nil
			return metadata && a == b
		})
}
func SameParticipantCeiling(a, b Participant) bool {
	return a.ParticipantID == b.ParticipantID && a.ParentParticipantID == b.ParentParticipantID &&
		a.Role == b.Role && a.MutationOwnership == b.MutationOwnership &&
		a.Grant.Identity == b.Grant.Identity && a.Grant.AuthorityID == b.Grant.AuthorityID &&
		a.Grant.ComputerID == b.Grant.ComputerID && a.Grant.ComputerGeneration == b.Grant.ComputerGeneration &&
		samePolicy(a.Grant.Policy, b.Grant.Policy)
}
func samePolicy(a, b Policy) bool {
	return a.FilePolicy == b.FilePolicy && a.Network == b.Network && a.Commands == b.Commands &&
		slices.Equal(a.Capabilities, b.Capabilities) && slices.Equal(a.ExcludedPaths, b.ExcludedPaths) &&
		slices.EqualFunc(a.Workspaces, b.Workspaces, func(a, b Scope) bool {
			return a.WorkspaceID == b.WorkspaceID && a.Root == b.Root && a.Mode == b.Mode &&
				a.Access == b.Access && a.RestrictionSource == b.RestrictionSource && slices.Equal(a.Paths, b.Paths)
		})
}

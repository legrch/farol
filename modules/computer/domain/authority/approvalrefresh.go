package authority

import "time"

// A scheduling margin, NOT another authority lifetime or a permission grant.
const ApprovalRefreshLeadTime = 5 * time.Minute
const ApprovalRefreshObservationAge = 5 * time.Second

// ApprovalRefreshBinding is captured by trusted Root from the SAME retained
// publication, live backend and current access owner. StoreRevision is the CAS
// precondition, not a request to create a participant or change generation.
// Never accept this value (or a RefreshWitness) from an external MCP body.
type ApprovalRefreshBinding struct {
	ProfileID, BackendGeneration, PublicationOperationID          string
	Fence, StoreRevision, ComputerGeneration, ConnectorGeneration uint64
}

// ApprovalRefreshWitness must come from a fresh independent owner-consent read
// under the existing activation/withdrawal guards. Merely cloning stored settings,
// changing their expiry or observing a live tunnel does NOT establish this proof.
// Explicit bounded/nonrenewable consent sets Renewable to false.
type ApprovalRefreshWitness struct {
	Binding            ApprovalRefreshBinding
	Approval           Approval
	ObservedAt         time.Time
	Current, Renewable bool
}

// ApprovalRefreshPlan is only a proposal to the existing access Store. It performs
// no IO, publication, re-admission, retry or change to an issued execution lease.
// Root must recheck live fences and the exact revision before one store commit,
// then atomically synchronize its current approval view. Uncertain publication
// must be observed/reconciled, never automatically attempted again.
type ApprovalRefreshPlan struct {
	Publish               bool
	ExpectedStoreRevision uint64
	PreviousExpiresAt     time.Time
	Approval              Approval
}

func validRefreshBinding(b ApprovalRefreshBinding) bool {
	return b.ProfileID != "" && b.BackendGeneration != "" && b.PublicationOperationID != "" &&
		b.Fence > 0 && b.StoreRevision > 0 && b.StoreRevision < ^uint64(0) &&
		b.ComputerGeneration > 0
}

func validRefreshTime(t time.Time) bool {
	return t.UnixMilli() > 0 && t.UnixMilli() <= 9007199254740991
}

// PlanApprovalRefresh permits TIME ONLY, within the same owner-approved policy.
// pinned is the original published policy; stored is the current sole Store value.
// A stale, revoked, changed or missing consent never becomes renewable by elapsed
// time. Expired stored time can be refreshed after idle/sleep ONLY with the fresh
// independently current renewable witness above. Old operation deadlines remain
// final, and this function never supplies permission to replay failed/UNKNOWN work.
func PlanApprovalRefresh(pinned, stored Approval, expected ApprovalRefreshBinding, witness ApprovalRefreshWitness, now time.Time) (*ApprovalRefreshPlan, error) {
	if expected.ConnectorGeneration == 0 {
		return nil, Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "approval-refresh")
	}
	return planApprovalRefresh(pinned, stored, expected, witness, now)
}

// PlanOwnerApprovalRefresh is for the acknowledged Settings owner alone. It
// grants no connector participant and refuses a supplied connector identity.
func PlanOwnerApprovalRefresh(pinned, stored Approval, expected ApprovalRefreshBinding, witness ApprovalRefreshWitness, now time.Time) (*ApprovalRefreshPlan, error) {
	if expected.ConnectorGeneration != 0 {
		return nil, Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "approval-refresh")
	}
	return planApprovalRefresh(pinned, stored, expected, witness, now)
}

func planApprovalRefresh(pinned, stored Approval, expected ApprovalRefreshBinding, witness ApprovalRefreshWitness, now time.Time) (*ApprovalRefreshPlan, error) {
	unavailable := func() (*ApprovalRefreshPlan, error) {
		return nil, Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "approval-refresh")
	}
	if !validRefreshBinding(expected) || witness.Binding != expected || !witness.Current || !witness.Renewable {
		return unavailable()
	}
	if !validRefreshTime(now) || !validRefreshTime(witness.ObservedAt) ||
		witness.ObservedAt.After(now) || now.Sub(witness.ObservedAt) > ApprovalRefreshObservationAge ||
		!validRefreshTime(pinned.ExpiresAt) || !validRefreshTime(stored.ExpiresAt) ||
		!validRefreshTime(witness.Approval.ExpiresAt) {
		return nil, Fail("AUTHORITY_EXPIRED", "approval-refresh")
	}
	if pinned.OwnerID == "" || pinned.ComputerID == "" || pinned.Generation == 0 ||
		len(pinned.Workspaces) == 0 || len(pinned.Capabilities) == 0 || !pinned.FilePolicy.Valid() ||
		pinned.Generation != expected.ComputerGeneration ||
		!SameApprovalPolicy(pinned, stored) || !SameApprovalPolicy(pinned, witness.Approval) {
		return nil, Fail("AUTHORITY_COMPUTER_MISMATCH", "approval-refresh")
	}
	// Do not hide a shortened owner deadline by reporting an unchanged lease as
	// healthy. Changed time limits use the normal owner transition, not renewal.
	if witness.Approval.ExpiresAt.Before(stored.ExpiresAt) {
		return unavailable()
	}
	deadline, err := lifetimeDeadline(witness.Approval, now, TaskGrantLifetime)
	if err != nil {
		return nil, err
	}
	plan := &ApprovalRefreshPlan{
		ExpectedStoreRevision: expected.StoreRevision,
		PreviousExpiresAt:     stored.ExpiresAt,
		Approval:              stored.Clone(),
	}
	if stored.ExpiresAt.After(now.Add(ApprovalRefreshLeadTime)) {
		return plan, nil
	}
	if !deadline.After(stored.ExpiresAt) {
		return unavailable()
	}
	plan.Publish = true
	plan.Approval.ExpiresAt = deadline
	return plan, nil
}

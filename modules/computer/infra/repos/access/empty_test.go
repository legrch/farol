package access

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Real disposable authority persistence, not an installed empty-catalogue or
// external connector witness. The Desktop producer remains separately gated.
func emptyStateFixture(t *testing.T) stateFixture {
	f := fixtureState(t)
	f.approval.Workspaces = nil
	f.approval.Capabilities = nil
	f.admission.Workspaces = nil
	f.admission.Capabilities = nil
	return f
}

func TestEmptyApprovalSurvivesRestoreWithoutCreatingAccess(t *testing.T) {
	f := emptyStateFixture(t)
	approve(t, f)
	p := admit(t, f)
	s := restored(t, f)
	v := snapshot(t, s, p.ParticipantID)
	if !status(t, s).ApprovalPresent || v.Approval == nil || !v.Approval.NoAccess() || v.Participant == nil || !v.Participant.Grant.Policy.NoAccess() || v.Participant.MutationOwnership != authority.NoOwnership {
		t.Fatal("empty approval confused with missing approval or gained access")
	}
	for _, kind := range []authority.Capability{authority.List, authority.Read, authority.Search, authority.Write, authority.Verify, authority.Shell, authority.NetworkUse} {
		if err := authority.AuthorizeComputer(*v.Participant, *v.Approval, authority.Action{Identity: f.admission.Identity, Operation: authority.Operation{Kind: kind, WorkspaceID: "work", Path: f.workspace}}, f.clock.Now()); err == nil {
			t.Fatalf("restored empty authority permitted %s", kind)
		}
	}
	if err := s.RevokeApproval(context.Background(), status(t, s).Revision); err != nil {
		t.Fatal(err)
	}
	if snapshot(t, s, p.ParticipantID).Approval != nil {
		t.Fatal("revocation became a connection-only approval")
	}
	if err := s.UpdateApproval(context.Background(), status(t, s).Revision, f.approval); err == nil {
		t.Fatal("stale empty approval resurrected after revocation")
	}
}

func TestEmptyApprovalRequiresLaterGenerationForScopeChanges(t *testing.T) {
	f := fixtureState(t)
	full := f.approval.Clone()
	approve(t, f)
	f.approval.Workspaces = nil
	f.approval.Capabilities = nil
	if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, f.approval); err == nil {
		t.Fatal("scope removal reused current generation")
	}
	f.approval.Generation++
	approve(t, f)
	full.Generation = f.approval.Generation
	if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, full); err == nil {
		t.Fatal("scope addition reused empty approval generation")
	}
	full.Generation++
	if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, full); err != nil {
		t.Fatal("normal new owner grant refused", err)
	}
}

func TestEmptyApprovalAndAdmissionRefuseResidualPermissions(t *testing.T) {
	for name, change := range map[string]func(*authority.Approval){
		"capability": func(a *authority.Approval) { a.Capabilities = []authority.Capability{authority.Read} },
		"network":    func(a *authority.Approval) { a.Network = authority.ApprovedNetwork },
		"commands":   func(a *authority.Approval) { a.Commands = authority.WorkspaceCommands },
		"exclusions": func(a *authority.Approval) {
			a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work"}}
		},
		"generation": func(a *authority.Approval) { a.Generation = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			f := emptyStateFixture(t)
			a := f.approval.Clone()
			change(&a)
			if err := f.store.UpdateApproval(context.Background(), 0, a); err == nil || status(t, f.store).Revision != 0 {
				t.Fatal("malformed empty approval persisted")
			}
		})
	}
	f := emptyStateFixture(t)
	approve(t, f)
	f.admission.Capabilities = []authority.Capability{authority.List}
	if _, err := f.store.Admit(context.Background(), status(t, f.store).Revision, f.admission, f.participant); err == nil {
		t.Fatal("empty admission gained listing authority")
	}
}

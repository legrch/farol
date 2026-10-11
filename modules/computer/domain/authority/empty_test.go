package authority

import (
	"testing"
	"time"
)

func emptyApprovalFixture() Approval {
	a := ownerFixture()
	a.Workspaces = nil
	a.Capabilities = nil
	return a
}

func TestEmptyApprovalCannotAuthorizeEffects(t *testing.T) {
	a := emptyApprovalFixture()
	now := time.UnixMilli(1800000000000)
	if !ownerApprovalValid(a) || !a.NoAccess() {
		t.Fatal("explicit empty approval refused")
	}
	id := Identity{OwnerID: a.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1}
	g, err := Derive(a, Admission{Identity: id, AuthorityID: "authority", ComputerID: a.ComputerID, ComputerGeneration: a.Generation, Policy: approvalPolicy(a)}, now)
	if err != nil {
		t.Fatal(err)
	}
	p, err := Create(*g, ParticipantAdmission{ParticipantID: "main", Role: Main, MutationOwnership: NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []Capability{List, Read, Search, Write, Verify, Shell, NetworkUse} {
		if err := AuthorizeComputer(*p, a, Action{Identity: id, Operation: Operation{Kind: kind, WorkspaceID: "invented", Path: "/invented", Write: kind == Write}}, now); err == nil {
			t.Fatalf("empty approval authorized %s", kind)
		}
	}
	for _, authorize := range []func(Approval, string, string, time.Time) error{AuthorizeOwnerList, AuthorizeOwnerRead, AuthorizeOwnerWrite} {
		if err := authorize(a, "invented", "/invented", now); err == nil {
			t.Fatal("empty approval authorized owner file access")
		}
	}
	if _, err := Create(*g, ParticipantAdmission{ParticipantID: "writer", Role: Main, MutationOwnership: TaskOwnership}); err == nil {
		t.Fatal("empty approval granted mutation ownership")
	}
	if _, err := Narrow(*g, Narrowing{Capabilities: []Capability{Read}, Network: NoNetwork, Commands: NoCommands}); err == nil {
		t.Fatal("empty grant gained file authority")
	}
}

func TestEmptyApprovalRejectsResidualAuthority(t *testing.T) {
	for name, change := range map[string]func(*Approval){
		"capability":  func(a *Approval) { a.Capabilities = []Capability{Read} },
		"network":     func(a *Approval) { a.Network = ApprovedNetwork },
		"commands":    func(a *Approval) { a.Commands = VerificationCommands },
		"exclusion":   func(a *Approval) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "old", Path: "/old"}} },
		"generation":  func(a *Approval) { a.Generation = 0 },
		"file policy": func(a *Approval) { a.FilePolicy = "unknown" },
		"expiry":      func(a *Approval) { a.ExpiresAt = time.Time{} },
	} {
		t.Run(name, func(t *testing.T) {
			a := emptyApprovalFixture()
			change(&a)
			if ownerApprovalValid(a) {
				t.Fatal("malformed empty approval accepted")
			}
		})
	}
}

func TestEmptyApprovalRenewalRetainsNoAccessAndCurrentConsent(t *testing.T) {
	pin, stored, binding, witness, now := refreshFixture()
	for _, a := range []*Approval{&pin, &stored, &witness.Approval} {
		a.Workspaces = nil
		a.Capabilities = nil
		a.ExcludedPaths = nil
	}
	p, err := PlanApprovalRefresh(pin, stored, binding, witness, now)
	if err != nil || p == nil || !p.Publish || !p.Approval.NoAccess() || p.Approval.Generation != pin.Generation {
		t.Fatalf("empty approval renewal: %+v %v", p, err)
	}
	witness.Current = false
	if p, err := PlanApprovalRefresh(pin, stored, binding, witness, now); err == nil || p != nil {
		t.Fatal("withdrawn empty approval renewed")
	}
	witness.Current = true
	witness.Approval.Capabilities = []Capability{Read}
	if p, err := PlanApprovalRefresh(pin, stored, binding, witness, now); err == nil || p != nil {
		t.Fatal("renewal added file access")
	}
}

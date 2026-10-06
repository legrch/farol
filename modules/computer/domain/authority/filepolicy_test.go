package authority

import (
	"testing"
	"time"
)

// Pure value tests; no native filesystem or shell qualification.
func TestFilePolicyDeriveModesAreIncomparable(t *testing.T) {
	for _, owner := range []FilePolicy{LegacyProtectedFiles, RootScopedFiles, "unknown"} {
		for _, task := range []FilePolicy{LegacyProtectedFiles, RootScopedFiles, "unknown"} {
			a, in, _ := fixtures(t)
			a.FilePolicy, in.FilePolicy = owner, task
			g, err := Derive(a, in, now)
			if !owner.Valid() || !task.Valid() || owner != task {
				if g != nil || err == nil {
					t.Fatalf("derived %q under %q: %v", task, owner, g)
				}
				continue
			}
			if err != nil || g.FilePolicy != task {
				t.Fatalf("lost mode: %v %v", g, err)
			}
			a.FilePolicy, in.FilePolicy = "changed", "changed"
			if g.Clone().FilePolicy != task {
				t.Fatal("captured grant changed")
			}
		}
	}
}

func TestFilePolicyClonesSealsAndNarrowing(t *testing.T) {
	for _, mode := range []FilePolicy{LegacyProtectedFiles, RootScopedFiles} {
		a, _, p := fixtures(t)
		a.FilePolicy, p.Grant.FilePolicy = mode, mode
		ac, pc := a.Clone(), p.Clone()
		if ac.FilePolicy != mode || pc.Grant.FilePolicy != mode || !SameApprovalPolicy(a, ac) || !SameParticipantCeiling(p, pc) {
			t.Fatal("mode lost in clone or equality")
		}
		other := RootScopedFiles
		if mode == RootScopedFiles {
			other = LegacyProtectedFiles
		}
		ac.FilePolicy, pc.Grant.FilePolicy = other, other
		if SameApprovalPolicy(a, ac) || SameParticipantCeiling(p, pc) {
			t.Fatal("mode change preserved seal")
		}
		child, err := Delegate(p, Delegation{ParticipantAdmission: ParticipantAdmission{ParticipantID: "child", Role: Critic, MutationOwnership: NoOwnership}, Narrowing: &Narrowing{Workspaces: []Scope{{WorkspaceID: "work", Root: "/work", Mode: Exact, Paths: []string{"/work/readme"}, Access: ReadAccess}}, ExcludedPaths: []Exclusion{{WorkspaceID: "work", Path: "/work/readme"}}, Capabilities: []Capability{Read}, Network: NoNetwork, Commands: NoCommands}})
		if err != nil || child.Grant.FilePolicy != mode || child.Grant.Workspaces[0].Mode != Exact || child.Grant.Workspaces[0].Access != ReadAccess || len(child.Grant.ExcludedPaths) != 1 {
			t.Fatalf("widened narrowing: %v %v", child, err)
		}
	}
	_, _, p := fixtures(t)
	p.Grant.FilePolicy = "unknown"
	if _, err := Create(p.Grant, ParticipantAdmission{ParticipantID: "child", Role: Critic, MutationOwnership: NoOwnership}); err == nil {
		t.Fatal("created unknown mode")
	}
	if _, err := Narrow(p.Grant, Narrowing{}); err == nil {
		t.Fatal("narrowed unknown mode")
	}
}

func TestFilePolicyStaleOwnerTransitionRefusesCapturedEffect(t *testing.T) {
	for _, mode := range []FilePolicy{LegacyProtectedFiles, RootScopedFiles} {
		a, in, p := fixtures(t)
		a.FilePolicy, in.FilePolicy, p.Grant.FilePolicy = mode, mode, mode
		op := action(p, Write, "/work/readme")
		if err := AuthorizeComputer(p, a, op, now); err != nil {
			t.Fatal(err)
		}
		lease, err := Lease(p, a, now, OrdinaryExecutionLifetime)
		if err != nil {
			t.Fatal(err)
		}
		if mode == LegacyProtectedFiles {
			a.FilePolicy = RootScopedFiles
		} else {
			a.FilePolicy = LegacyProtectedFiles
		}
		failure(t, AuthorizeComputer(lease.Participant(), a, op, now), "AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
		if _, err := Reissue(a, in, now, time.Minute); err == nil {
			t.Fatal("reissued stale mode")
		}
		if _, err := Lease(p, a, now, OrdinaryExecutionLifetime); err == nil {
			t.Fatal("leased stale mode")
		}
		a.Generation++
		failure(t, AuthorizeComputer(p, a, op, now), "AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
		if lease.Participant().Grant.FilePolicy != mode {
			t.Fatal("lease changed retrospectively")
		}
	}
}

func TestFilePolicyUnknownRefusesOwnerAndTask(t *testing.T) {
	a, _, p := fixtures(t)
	a.FilePolicy = "unknown"
	failure(t, AuthorizeOwnerRead(a, "work", "/work/readme", now), "COMPUTER_APPROVAL_INVALID", "computer-approval")
	failure(t, AuthorizeOwnerList(a, "work", "/work", now), "COMPUTER_APPROVAL_INVALID", "computer-approval")
	failure(t, AuthorizeOwnerWrite(a, "work", "/work/readme", now), "COMPUTER_APPROVAL_INVALID", "computer-approval")
	p.Grant.FilePolicy = "unknown"
	failure(t, AuthorizeTask(p, action(p, Read, "/work/readme"), now), "AUTHORITY_INFLATION_DENIED", "task-grant")
}

func TestFilePolicyNativeHostSelectionMustMatchCapturedTask(t *testing.T) {
	_, _, p := fixtures(t)
	p.Grant.FilePolicy = RootScopedFiles
	host := NativeHost{OwnerID: p.Grant.OwnerID, TaskID: p.Grant.TaskID, TaskEpoch: p.Grant.TaskEpoch, Policy: p.Grant.Policy}
	op := action(p, Read, "/work/readme")
	if err := AuthorizeNativeHost(p, host, op, now); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []FilePolicy{LegacyProtectedFiles, "unknown"} {
		host.FilePolicy = mode
		failure(t, AuthorizeNativeHost(p, host, op, now), "AUTHORITY_COMPUTER_MISMATCH", "native-host")
	}
}

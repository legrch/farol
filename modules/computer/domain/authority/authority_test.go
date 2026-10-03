package authority

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// These are pure policy fixtures, not native filesystem/provider evidence.
var now = time.Unix(1000, 0)

func fixtures(t *testing.T) (Approval, Admission, Participant) {
	t.Helper()
	a := Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3, Workspaces: []ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: WriteAccess, RootIdentity: RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []Capability{Read, List, Search, Verify, Write, Shell}, Network: ApprovedNetwork, Commands: WorkspaceCommands, ExpiresAt: now.Add(time.Hour)}
	admission := Admission{Identity: Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 4}, AuthorityID: "grant", ComputerID: "computer", ComputerGeneration: 3, Policy: Policy{Workspaces: []Scope{{WorkspaceID: "work", Root: "/work", Mode: Subtree, Access: WriteAccess}}, Capabilities: append([]Capability(nil), a.Capabilities...), Network: ApprovedNetwork, Commands: WorkspaceCommands, ExpiresAt: now.Add(time.Minute)}}
	g, err := Derive(a, admission, now)
	if err != nil {
		t.Fatal(err)
	}
	p, err := Create(*g, ParticipantAdmission{ParticipantID: "main", Role: Main, MutationOwnership: TaskOwnership})
	if err != nil {
		t.Fatal(err)
	}
	return a, admission, *p
}
func action(p Participant, kind Capability, path string) Action {
	return Action{Identity: p.Grant.Identity, Operation: Operation{Kind: kind, WorkspaceID: "work", Path: path}}
}
func failure(t *testing.T, err error, code, source string) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != code || f.Source != source || f.Retry != "never" {
		t.Fatalf("got %v, want %s from %s with retry never", err, code, source)
	}
}
func TestDeriveRejectsInflationAndStaleIdentity(t *testing.T) {
	tests := []struct {
		name, code, source string
		change             func(*Approval, *Admission)
	}{
		{"foreign owner", "AUTHORITY_OWNER_MISMATCH", "computer-approval", func(a *Approval, n *Admission) { n.OwnerID = "other" }},
		{"foreign computer", "AUTHORITY_COMPUTER_MISMATCH", "computer-approval", func(a *Approval, n *Admission) { n.ComputerID = "other" }},
		{"stale computer generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-approval", func(a *Approval, n *Admission) { n.ComputerGeneration++ }},
		{"expired admission", "AUTHORITY_EXPIRED", "task-admission", func(a *Approval, n *Admission) { n.ExpiresAt = now.Add(-time.Second) }},
		{"expired approval", "AUTHORITY_EXPIRED", "task-admission", func(a *Approval, n *Admission) { a.ExpiresAt = now.Add(-time.Second) }},
		{"extended deadline", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.ExpiresAt = a.ExpiresAt.Add(time.Second) }},
		{"capability", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { a.Capabilities = []Capability{Read} }},
		{"network", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { a.Network = NoNetwork }},
		{"commands", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { a.Commands = VerificationCommands }},
		{"unknown network", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.Network = "unknown" }},
		{"root escape", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.Workspaces[0].Root = "/work/../outside" }},
		{"case grant inflation", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.Workspaces[0].Root = "/WORK" }},
		{"duplicate workspace", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.Workspaces = append(n.Workspaces, n.Workspaces[0]) }},
		{"empty exact scope", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.Workspaces[0].Mode = Exact }},
		{"duplicate exact path", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) {
			n.Workspaces[0].Mode = Exact
			n.Workspaces[0].Paths = []string{"/work/a", "/work/a"}
		}},
		{"exact path escape", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) {
			n.Workspaces[0].Mode = Exact
			n.Workspaces[0].Paths = []string{"/other/a"}
		}},
		{"invalid admission exclusion", "AUTHORITY_INFLATION_DENIED", "task-admission", func(a *Approval, n *Admission) { n.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/other"}} }},
		{"invalid approval exclusion", "AUTHORITY_INFLATION_DENIED", "computer-approval", func(a *Approval, n *Admission) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/other"}} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			a, n, _ := fixtures(t)
			test.change(&a, &n)
			g, err := Derive(a, n, now)
			if g != nil {
				t.Fatal("issued an unauthorized grant")
			}
			failure(t, err, test.code, test.source)
		})
	}
}
func TestNarrowingAndDelegationAreMonotonic(t *testing.T) {
	_, _, p := fixtures(t)
	n := Narrowing{Workspaces: []Scope{{WorkspaceID: "work", Root: "/work", Mode: Exact, Paths: []string{"/work/readme"}, Access: ReadAccess}}, Capabilities: []Capability{Read}, Network: NoNetwork, Commands: NoCommands}
	child, err := Delegate(p, Delegation{ParticipantAdmission: ParticipantAdmission{ParticipantID: "critic", Role: Critic, MutationOwnership: NoOwnership}, Narrowing: &n})
	if err != nil {
		t.Fatal(err)
	}
	if child.ParentParticipantID != p.ParticipantID || child.Grant.ExpiresAt != p.Grant.ExpiresAt || child.Grant.ComputerGeneration != p.Grant.ComputerGeneration || child.Grant.AuthorityID != p.Grant.AuthorityID {
		t.Fatal("lost authority identity")
	}
	if err := AuthorizeTask(*child, action(*child, Read, "/work/readme"), now); err != nil {
		t.Fatal(err)
	}
	failure(t, AuthorizeTask(*child, action(*child, Read, "/work/related"), now), "AUTHORITY_PATH_DENIED", "owner-restriction")
	wider := n
	wider.Workspaces = []Scope{{WorkspaceID: "work", Root: "/work", Mode: Subtree, Access: ReadAccess}}
	if _, err := Narrow(child.Grant, wider); err == nil {
		t.Fatal("exact widened to subtree")
	} else {
		failure(t, err, "AUTHORITY_INFLATION_DENIED", "owner-restriction")
	}
	if _, err := Delegate(*child, Delegation{ParticipantAdmission: ParticipantAdmission{ParticipantID: "writer", Role: Agent, MutationOwnership: TaskOwnership}}); err == nil {
		t.Fatal("inflated ownership")
	} else {
		failure(t, err, "AUTHORITY_INFLATION_DENIED", "role")
	}
	// Delegation snapshots cannot be changed through caller-owned slices.
	n.Workspaces[0].Paths[0] = "/work/other"
	if child.Grant.Workspaces[0].Paths[0] != "/work/readme" {
		t.Fatal("retained caller slice")
	}
	unchanged, err := Delegate(*child, Delegation{ParticipantAdmission: ParticipantAdmission{ParticipantID: "next", Role: Agent, MutationOwnership: NoOwnership}})
	if err != nil {
		t.Fatal(err)
	}
	child.Grant.Workspaces[0].Paths[0] = "/work/changed"
	if unchanged.Grant.Workspaces[0].Paths[0] != "/work/readme" {
		t.Fatal("shared delegated slice")
	}
}
func TestExclusionAliasesSurviveNarrowing(t *testing.T) {
	for _, pair := range [][2]string{{"private", "PRIVATE"}, {"Café", "Cafe\u0301"}, {"Café", "CAFE"}, {"Straße", "STRASSE"}, {"ΟΣ", "ος"}, {"ﬃ", "ffi"}, {"Key", "key"}, {"Ｆｏｏ", "foo"}} {
		t.Run(pair[1], func(t *testing.T) {
			a, n, _ := fixtures(t)
			a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/" + pair[0]}}
			g, err := Derive(a, n, now)
			if err != nil {
				t.Fatal(err)
			}
			narrowed, err := Narrow(*g, Narrowing{Workspaces: []Scope{{WorkspaceID: "work", Root: "/work/" + pair[1], Mode: Exact, Paths: []string{"/work/" + pair[1] + "/secret"}, Access: ReadAccess}}, Capabilities: []Capability{Read}, Network: NoNetwork, Commands: NoCommands})
			if err != nil {
				t.Fatal(err)
			}
			p, err := Create(*narrowed, ParticipantAdmission{ParticipantID: "critic", Role: Critic, MutationOwnership: NoOwnership})
			if err != nil {
				t.Fatal(err)
			}
			failure(t, AuthorizeTask(*p, action(*p, Read, "/work/"+pair[1]+"/secret"), now), "AUTHORITY_PATH_DENIED", "computer-approval")
			if ComparableWithin("/work/"+pair[0], "/work/"+pair[1]+"-docs/readme") {
				t.Fatal("component prefix overreach")
			}
		})
	}
	if !ComparableWithin("/", "/work/a") || ComparableWithin("/work", "/work/../outside") {
		t.Fatal("root/canonical comparison")
	}
}
func TestRestrictionProvenance(t *testing.T) {
	for _, source := range []Source{ComputerApprovalSource, TaskGrantSource, OwnerRestrictionSource, UnknownSource, ""} {
		_, _, p := fixtures(t)
		p.Grant.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/private", RestrictionSource: source}}
		failure(t, AuthorizeTask(p, action(p, Read, "/work/private/a"), now), "AUTHORITY_PATH_DENIED", DenialSource(source))
	}
	for _, source := range []Source{TaskGrantSource, OwnerRestrictionSource, UnknownSource} {
		_, _, p := fixtures(t)
		p.Grant.Workspaces[0].RestrictionSource = source
		failure(t, AuthorizeTask(p, action(p, Read, "/outside"), now), "AUTHORITY_PATH_DENIED", DenialSource(source))
		missing := action(p, Read, "/work/a")
		missing.Operation.WorkspaceID = "missing"
		failure(t, AuthorizeTask(p, missing, now), "AUTHORITY_PATH_DENIED", "task-grant")
	}
}
func TestActionBoundariesAndCurrentRevocation(t *testing.T) {
	cases := []struct {
		name, code, source string
		change             func(*Participant, *Approval, *Action)
	}{
		{"owner", "AUTHORITY_OWNER_MISMATCH", "task-grant", func(p *Participant, a *Approval, x *Action) { x.OwnerID = "foreign" }},
		{"session", "AUTHORITY_TASK_MISMATCH", "task-grant", func(p *Participant, a *Approval, x *Action) { x.SessionID = "foreign" }},
		{"task", "AUTHORITY_TASK_MISMATCH", "task-grant", func(p *Participant, a *Approval, x *Action) { x.TaskID = "foreign" }},
		{"epoch", "AUTHORITY_TASK_MISMATCH", "task-grant", func(p *Participant, a *Approval, x *Action) { x.TaskEpoch++ }},
		{"policy owner", "AUTHORITY_OWNER_MISMATCH", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.OwnerID = "foreign" }},
		{"computer", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.ComputerID = "foreign" }},
		{"computer generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.Generation++ }},
		{"grant expiration", "AUTHORITY_EXPIRED", "task-grant", func(p *Participant, a *Approval, x *Action) { p.Grant.ExpiresAt = now.Add(-time.Second) }},
		{"approval expiration", "AUTHORITY_EXPIRED", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.ExpiresAt = now.Add(-time.Second) }},
		{"revoked capability", "AUTHORITY_CAPABILITY_DENIED", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.Capabilities = nil }},
		{"revoked root", "AUTHORITY_PATH_DENIED", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.Workspaces = nil }},
		{"revoked network", "AUTHORITY_NETWORK_DENIED", "computer-policy", func(p *Participant, a *Approval, x *Action) { a.Network = NoNetwork; x.Operation.Kind = NetworkUse }},
		{"task network", "AUTHORITY_NETWORK_DENIED", "task-grant", func(p *Participant, a *Approval, x *Action) {
			p.Grant.Network = NoNetwork
			x.Operation.Kind = NetworkUse
		}},
		{"verification commands", "AUTHORITY_COMMAND_DENIED", "task-grant", func(p *Participant, a *Approval, x *Action) { p.Grant.Commands = NoCommands; x.Operation.Kind = Verify }},
		{"shell commands", "AUTHORITY_COMMAND_DENIED", "computer-policy", func(p *Participant, a *Approval, x *Action) {
			a.Commands = VerificationCommands
			x.Operation.Kind = Shell
		}},
		{"write ownership", "AUTHORITY_MUTATION_OWNERSHIP_DENIED", "role", func(p *Participant, a *Approval, x *Action) {
			p.MutationOwnership = NoOwnership
			x.Operation.Kind = Write
		}},
		{"shell ownership", "AUTHORITY_MUTATION_OWNERSHIP_DENIED", "role", func(p *Participant, a *Approval, x *Action) {
			p.MutationOwnership = NoOwnership
			x.Operation.Kind = Shell
			x.Operation.Write = true
		}},
		{"write access", "AUTHORITY_PATH_DENIED", "task-grant", func(p *Participant, a *Approval, x *Action) {
			p.Grant.Workspaces[0].Access = ReadAccess
			x.Operation.Kind = Write
		}},
		{"policy exclusion", "AUTHORITY_PATH_DENIED", "computer-policy", func(p *Participant, a *Approval, x *Action) {
			a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
			x.Operation.Path = "/work/PRIVATE/a"
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			a, _, p := fixtures(t)
			x := action(p, Read, "/work/a")
			test.change(&p, &a, &x)
			failure(t, AuthorizeComputer(p, a, x, now), test.code, test.source)
		})
	}
	a, _, p := fixtures(t)
	if err := AuthorizeComputer(p, a, action(p, Read, "/work/unknown-related"), p.Grant.ExpiresAt); err != nil {
		t.Fatalf("expiry boundary should remain inclusive: %v", err)
	}
	host := NativeHost{OwnerID: p.Grant.OwnerID, TaskID: p.Grant.TaskID, TaskEpoch: p.Grant.TaskEpoch, Policy: clonePolicy(p.Grant.Policy)}
	host.Capabilities = []Capability{Read}
	failure(t, AuthorizeNativeHost(p, host, action(p, Write, "/work/a"), now), "AUTHORITY_CAPABILITY_DENIED", "native-host")
	host.TaskEpoch++
	failure(t, AuthorizeNativeHost(p, host, action(p, Read, "/work/a"), now), "AUTHORITY_TASK_MISMATCH", "native-host")
}
func TestExclusionBudgetAndRootScopedApproval(t *testing.T) {
	a, n, _ := fixtures(t)
	a.Workspaces[0].Root = "/"
	n.Workspaces[0].Root = "/"
	n.Workspaces[0].Mode = Exact
	n.Workspaces[0].Paths = []string{"/readme"}
	if _, err := Derive(a, n, now); err != nil {
		t.Fatal(err)
	}
	a, n, _ = fixtures(t)
	for i := 0; i < 20; i++ {
		a.ExcludedPaths = append(a.ExcludedPaths, Exclusion{WorkspaceID: "work", Path: fmt.Sprintf("/work/approval%d", i)})
		n.ExcludedPaths = append(n.ExcludedPaths, Exclusion{WorkspaceID: "work", Path: fmt.Sprintf("/work/task%d", i)})
	}
	_, err := Derive(a, n, now)
	failure(t, err, "AUTHORITY_INFLATION_DENIED", "task-admission")
}

package workspace

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Policy doubles, not native root or real Task/Chat admission evidence.
func contextFixture(t *testing.T) (*Service, *authorities, *approvals, *native, *clock, ContextRequest) {
	t.Helper()
	s, p, a, n, c, r := fixture(t)
	n.list.Binding = &port.DirectoryBinding{RelativePath: ".", Root: "/work", ApprovedRoot: port.Root{Path: "/work", Device: "1", Inode: "2"}}
	return s, p, a, n, c, ContextRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID,
		Generation: r.Generation, CallID: r.CallID, WorkspaceID: r.WorkspaceID, RelativePath: "."}
}

func TestContextUsesCheckedDirectoryWithoutDisclosingItsEntries(t *testing.T) {
	s, p, _, n, _, r := contextFixture(t)
	p.p.Grant.Workspaces[0].Root = "/work/src"
	p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/src/secret", RestrictionSource: authority.OwnerRestrictionSource}}
	n.list.Binding.Root = "/work/src"
	n.list.Entries = []string{"private-directory-entry"}
	n.list.Truncated = true
	r.RelativePath = "nested"
	n.list.Binding.RelativePath = "nested"
	out, err := s.Context(context.Background(), r)
	if err != nil || out == nil {
		t.Fatalf("context: %v", err)
	}
	if out.Root != "/work/src" || out.ApprovedRoot.Path != "/work" || out.ApprovedRoot.Device != "1" || out.ApprovedRoot.Inode != "2" || out.Scope != "subtree" || out.CallID != r.CallID || out.TurnID != r.TurnID || out.Generation != r.Generation || out.RelativePath != "nested" {
		t.Fatalf("wrong context/correlation: %#v", out)
	}
	if n.reads != 0 || n.lists != 1 || n.listRequest.RelativePath != "nested" || n.listRequest.Workspace.Root != "/work/src" || len(n.listRequest.Workspace.DeniedPaths) != 1 || n.listRequest.Workspace.DeniedPaths[0] != "secret" {
		t.Fatal("context bypassed list checks or lost narrowed descriptor")
	}
	n.list.Binding.ApprovedRoot.Inode = "999"
	if out.ApprovedRoot.Inode != "2" {
		t.Fatal("context aliases native response")
	}
}

func TestContextRequiresNativeBindingRatherThanPolicyMetadata(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*native)
	}{
		{"missing response", "WORKSPACE_HELPER_FAILED", func(n *native) { n.list = nil }},
		{"missing native binding", "WORKSPACE_HELPER_FAILED", func(n *native) { n.list.Binding = nil }},
		{"missing selected directory", "WORKSPACE_HELPER_FAILED", func(n *native) { n.list.Binding.RelativePath = "" }},
		{"different selected directory", "WORKSPACE_ROOT_CHANGED", func(n *native) { n.list.Binding.RelativePath = "other" }},
		{"malformed root", "WORKSPACE_HELPER_FAILED", func(n *native) { n.list.Binding.Root = "relative" }},
		{"malformed inode", "WORKSPACE_HELPER_FAILED", func(n *native) { n.list.Binding.ApprovedRoot.Inode = "not-an-inode" }},
		{"different root", "WORKSPACE_ROOT_CHANGED", func(n *native) { n.list.Binding.Root = "/work/foreign" }},
		{"different ancestor", "WORKSPACE_HELPER_FAILED", func(n *native) { n.list.Binding.ApprovedRoot.Path = "/" }},
		{"different device", "WORKSPACE_ROOT_CHANGED", func(n *native) { n.list.Binding.ApprovedRoot.Device = "9" }},
		{"different inode", "WORKSPACE_ROOT_CHANGED", func(n *native) { n.list.Binding.ApprovedRoot.Inode = "9" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, _, n, _, r := contextFixture(t)
			test.change(n)
			out, err := s.Context(context.Background(), r)
			if out != nil {
				t.Fatal("unverified context disclosed")
			}
			expectFailure(t, err, test.code, "native-workspace")
		})
	}
}

func TestContextExactScopeCannotBecomeDirectoryAuthority(t *testing.T) {
	s, p, _, n, _, r := contextFixture(t)
	p.p.Grant.Workspaces[0].Mode = authority.Exact
	p.p.Grant.Workspaces[0].Paths = []string{"/work/AGENTS.md"}
	r.RelativePath = "AGENTS.md"
	out, err := s.Context(context.Background(), r)
	if out != nil || n.lists != 0 {
		t.Fatal("exact scope reached directory execution")
	}
	expectFailure(t, err, "AUTHORITY_PATH_DENIED", "task-grant")
}

func TestContextRefusesAbsentOrUnavailableOwnersBeforeNative(t *testing.T) {
	for _, test := range []struct {
		name, code, source string
		change             func(*authorities, *approvals, *ContextRequest)
	}{
		{"participant absent", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, _ *approvals, _ *ContextRequest) { p.p = nil }},
		{"participant unavailable", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store", func(p *authorities, _ *approvals, _ *ContextRequest) { p.err = errors.New("private diagnostic") }},
		{"approval absent", "COMPUTER_APPROVAL_NOT_FOUND", "computer-policy", func(_ *authorities, a *approvals, _ *ContextRequest) { a.a = nil }},
		{"approval unavailable", "COMPUTER_APPROVAL_STORE_UNAVAILABLE", "authority-store", func(_ *authorities, a *approvals, _ *ContextRequest) { a.err = errors.New("private diagnostic") }},
		{"invalid path", "COMPUTER_PATH_INVALID", "task-grant", func(_ *authorities, _ *approvals, r *ContextRequest) { r.RelativePath = "../outside" }},
		{"missing workspace", "AUTHORITY_PATH_DENIED", "task-grant", func(_ *authorities, _ *approvals, r *ContextRequest) { r.WorkspaceID = "guessed" }},
		{"no list capability", "AUTHORITY_CAPABILITY_DENIED", "computer-policy", func(_ *authorities, a *approvals, _ *ContextRequest) {
			a.a.Capabilities = []authority.Capability{authority.Read}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, _, r := contextFixture(t)
			test.change(p, a, &r)
			out, err := s.Context(context.Background(), r)
			if out != nil || n.lists != 0 {
				t.Fatal("refused context reached native IO")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
}

func TestContextDiscardsCheckedRootAfterAuthorityChanges(t *testing.T) {
	for _, test := range []struct {
		name, code, source string
		change             func(*authorities, *approvals)
	}{
		{"participant revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, _ *approvals) { p.p = nil }},
		{"approval revoke", "COMPUTER_APPROVAL_NOT_FOUND", "computer-policy", func(_ *authorities, a *approvals) { a.a = nil }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(_ *authorities, a *approvals) { a.a.Generation++ }},
		{"ancestor replaced", "WORKSPACE_ROOT_CHANGED", "native-workspace", func(_ *authorities, a *approvals) { a.a.Workspaces[0].RootIdentity.Inode = "999" }},
		{"scope rebound", "AUTHORITY_PATH_DENIED", "task-grant", func(p *authorities, _ *approvals) { p.p.Grant.Workspaces[0].Root = "/work/other" }},
		{"descendant exclusion", "AUTHORITY_PATH_DENIED", "computer-policy", func(_ *authorities, a *approvals) {
			a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, _, r := contextFixture(t)
			n.hook = func() { test.change(p, a) }
			out, err := s.Context(context.Background(), r)
			if out != nil || n.lists != 1 {
				t.Fatal("stale context disclosed")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
}

func TestContextPreservesNativeRefusalAndCancellation(t *testing.T) {
	for _, code := range []string{"WORKSPACE_NOT_FOUND", "WORKSPACE_PATH_REFUSED", "WORKSPACE_RACE_DETECTED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_REQUEST_CANCELLED"} {
		t.Run(code, func(t *testing.T) {
			s, _, _, n, _, r := contextFixture(t)
			n.err = authority.Fail(code, "private-native-setting")
			out, err := s.Context(context.Background(), r)
			if out != nil {
				t.Fatal("native refusal became a context")
			}
			expectFailure(t, err, code, "native-workspace")
		})
	}
	s, _, _, n, _, r := contextFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	n.hook = cancel
	out, err := s.Context(ctx, r)
	if out != nil {
		t.Fatal("cancelled context disclosed")
	}
	expectFailure(t, err, "WORKSPACE_REQUEST_CANCELLED", "native-workspace")
}

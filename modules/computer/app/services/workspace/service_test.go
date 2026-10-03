package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Test doubles prove policy/disclosure only, never native filesystem facts.
type authorities struct {
	p    *authority.Participant
	err  error
	hook func()
}

type approvals struct {
	a    *authority.Approval
	err  error
	hook func()
}

// This double models one coherent snapshot callback, never two awaited Gets.
type access struct {
	p *authorities
	a *approvals
}

func (store access) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	if store.p.hook != nil {
		store.p.hook()
	}
	if store.a.hook != nil {
		store.a.hook()
	}
	if store.p.err != nil {
		return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	if store.a.err != nil {
		return authority.Fail("COMPUTER_APPROVAL_STORE_UNAVAILABLE", "authority-store")
	}
	return inspect(port.AccessSnapshot{Participant: store.p.p, Approval: store.a.a})
}

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

type native struct {
	reads, lists int
	readRequest  port.ReadRequest
	listRequest  port.ListRequest
	hook         func()
	err          error
	read         *port.ReadResponse
	list         *port.ListResponse
	ctx          context.Context
}

func (n *native) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.reads++
	n.readRequest = r
	n.ctx = ctx
	if n.hook != nil {
		n.hook()
	}
	return n.read, n.err
}
func (n *native) List(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
	n.lists++
	n.listRequest = r
	n.ctx = ctx
	if n.hook != nil {
		n.hook()
	}
	return n.list, n.err
}
func fixture(t *testing.T) (*Service, *authorities, *approvals, *native, *clock, ReadRequest) {
	t.Helper()
	c := &clock{now: time.Unix(1000, 0)}
	a := &approvals{a: &authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: c.now.Add(time.Hour)}}
	g, err := authority.Derive(*a.a, authority.Admission{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 4}, AuthorityID: "grant", ComputerID: "computer", ComputerGeneration: 3, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: c.now.Add(time.Minute)}}, c.now)
	if err != nil {
		t.Fatal(err)
	}
	p, err := authority.Create(*g, authority.ParticipantAdmission{ParticipantID: "critic", Role: authority.Critic, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	repo := &authorities{p: p}
	n := &native{read: &port.ReadResponse{Text: "private text", Bytes: 12, SHA256: "digest"}, list: &port.ListResponse{Entries: []string{"readme"}}}
	r := ReadRequest{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 4, ParticipantID: "critic", TurnID: "turn", Generation: 5, CallID: "call", WorkspaceID: "work", RelativePath: "readme"}
	return New(access{p: repo, a: a}, n, c), repo, a, n, c, r
}
func expectFailure(t *testing.T, err error, code, source string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != code || f.Source != source || f.Retry != "never" {
		t.Fatalf("got %v, want %s from %s", err, code, source)
	}
}
func listRequest(r ReadRequest) ListRequest {
	return ListRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID, WorkspaceID: r.WorkspaceID, RelativePath: "."}
}
func TestReadBuildsNativeAuthorityAndIndependentResponse(t *testing.T) {
	s, p, a, n, _, r := fixture(t)
	p.p.Grant.Workspaces[0].Root = "/work/src"
	p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/src/private", RestrictionSource: authority.OwnerRestrictionSource}}
	a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/src/cache"}}
	r.RelativePath = "readme"
	r.Range = &Range{Offset: 2, Length: 4}
	next := uint64(6)
	n.read = &port.ReadResponse{Text: "text", Bytes: 4, Page: &port.Page{Offset: 2, Size: 8, NextOffset: &next}}
	ctx := context.Background()
	result, err := s.Read(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	d := n.readRequest.Workspace
	if d.Root != "/work/src" || d.ApprovedRoot.Path != "/work" || d.ApprovedRoot.Device != "1" || d.ApprovedRoot.Inode != "2" || d.ExactFilePaths != nil || len(d.DeniedPaths) != 2 {
		t.Fatalf("wrong descriptor: %#v", d)
	}
	if n.ctx != ctx || n.reads != 1 || result.CallID != r.CallID || result.Generation != r.Generation || result.TurnID != r.TurnID || result.WorkspaceID != r.WorkspaceID || result.Page.NextOffset == n.read.Page.NextOffset {
		t.Fatal("lost correlation/context or aliased response")
	}
	if n.readRequest.Range.Offset != 2 || n.readRequest.Range.Length != 4 {
		t.Fatal("lost byte range")
	}
}
func TestExactReadNeverGrantsDirectoryListing(t *testing.T) {
	s, p, _, n, _, r := fixture(t)
	p.p.Grant.Workspaces[0].Mode = authority.Exact
	p.p.Grant.Workspaces[0].Paths = []string{"/work/readme"}
	if _, err := s.Read(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if n.readRequest.Workspace.ExactFilePaths == nil || len(n.readRequest.Workspace.ExactFilePaths) != 1 || n.readRequest.Workspace.ExactFilePaths[0] != "readme" {
		t.Fatal("lost exact allowlist")
	}
	result, err := s.List(context.Background(), listRequest(r))
	if result != nil {
		t.Fatal("disclosed list")
	}
	expectFailure(t, err, "AUTHORITY_PATH_DENIED", "task-grant")
	if n.lists != 0 {
		t.Fatal("reached native list")
	}
	r.RelativePath = "other"
	res, err := s.Read(context.Background(), r)
	if res != nil {
		t.Fatal("disclosed related file")
	}
	expectFailure(t, err, "AUTHORITY_PATH_DENIED", "task-grant")
}
func TestReadRefusesBeforeNative(t *testing.T) {
	tests := []struct {
		name, code, source string
		change             func(*authorities, *approvals, *ReadRequest)
	}{
		{"owner", "AUTHORITY_OWNER_MISMATCH", "task-grant", func(p *authorities, a *approvals, r *ReadRequest) { r.OwnerID = "other" }},
		{"session", "AUTHORITY_TASK_MISMATCH", "task-grant", func(p *authorities, a *approvals, r *ReadRequest) { r.SessionID = "other" }},
		{"epoch", "AUTHORITY_TASK_MISMATCH", "task-grant", func(p *authorities, a *approvals, r *ReadRequest) { r.TaskEpoch++ }},
		{"missing grant", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, a *approvals, r *ReadRequest) { p.p = nil }},
		{"authority store", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store", func(p *authorities, a *approvals, r *ReadRequest) { p.err = errors.New("private store detail") }},
		{"missing approval", "COMPUTER_APPROVAL_NOT_FOUND", "computer-policy", func(p *authorities, a *approvals, r *ReadRequest) { a.a = nil }},
		{"approval store", "COMPUTER_APPROVAL_STORE_UNAVAILABLE", "authority-store", func(p *authorities, a *approvals, r *ReadRequest) { a.err = errors.New("private store detail") }},
		{"missing workspace", "AUTHORITY_PATH_DENIED", "task-grant", func(p *authorities, a *approvals, r *ReadRequest) { r.WorkspaceID = "missing" }},
		{"revoked capability", "AUTHORITY_CAPABILITY_DENIED", "computer-policy", func(p *authorities, a *approvals, r *ReadRequest) { a.a.Capabilities = nil }},
		{"stale generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(p *authorities, a *approvals, r *ReadRequest) { a.a.Generation++ }},
		{"denied alias", "AUTHORITY_PATH_DENIED", "owner-restriction", func(p *authorities, a *approvals, r *ReadRequest) {
			p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/Café", RestrictionSource: authority.OwnerRestrictionSource}}
			r.RelativePath = "CAFE/secret"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, _, r := fixture(t)
			test.change(p, a, &r)
			result, err := s.Read(context.Background(), r)
			if result != nil || n.reads != 0 {
				t.Fatal("disclosed/reached native")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
	for _, path := range []string{"", "/absolute", "../escape", "a/../b", "a//b", "a/./b", "a/", "a\\b", "a\x00b", "a\nb", "a\x7fb", string([]byte{0xff})} {
		t.Run(path, func(t *testing.T) {
			s, _, _, n, _, r := fixture(t)
			r.RelativePath = path
			result, err := s.Read(context.Background(), r)
			if result != nil || n.reads != 0 {
				t.Fatal("disclosed/reached native")
			}
			expectFailure(t, err, "COMPUTER_PATH_INVALID", "task-grant")
		})
	}
}
func TestNoDisclosureAfterNativeYield(t *testing.T) {
	tests := []struct {
		name, code, source string
		change             func(*authorities, *approvals, *clock, context.CancelFunc)
	}{
		{"missing grant", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { p.p = nil }},
		{"authority unavailable", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { p.err = errors.New("private") }},
		{"missing approval", "COMPUTER_APPROVAL_NOT_FOUND", "computer-policy", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { a.a = nil }},
		{"approval unavailable", "COMPUTER_APPROVAL_STORE_UNAVAILABLE", "authority-store", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { a.err = errors.New("private") }},
		{"identity changed", "AUTHORITY_TASK_MISMATCH", "task-grant", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { p.p.Grant.TaskID = "other" }},
		{"scope changed", "WORKSPACE_ROOT_CHANGED", "native-workspace", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) {
			p.p.Grant.Workspaces[0].Mode = authority.Exact
			p.p.Grant.Workspaces[0].Paths = []string{"/work/readme"}
		}},
		{"root inode changed", "WORKSPACE_ROOT_CHANGED", "native-workspace", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) {
			a.a.Workspaces[0].RootIdentity.Inode = "other"
		}},
		{"root device changed", "WORKSPACE_ROOT_CHANGED", "native-workspace", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) {
			a.a.Workspaces[0].RootIdentity.Device = "other"
		}},
		{"approved root changed", "WORKSPACE_ROOT_CHANGED", "native-workspace", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { a.a.Workspaces[0].Root = "/" }},
		{"capability revoked", "AUTHORITY_CAPABILITY_DENIED", "computer-policy", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { a.a.Capabilities = nil }},
		{"grant capability revoked", "AUTHORITY_CAPABILITY_DENIED", "task-grant", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { p.p.Grant.Capabilities = nil }},
		{"generation changed", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { a.a.Generation++ }},
		{"grant replaced", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) {
			p.p.Grant.AuthorityID = "new-grant"
		}},
		{"expired", "AUTHORITY_EXPIRED", "task-grant", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) {
			c.now = c.now.Add(2 * time.Minute)
		}},
		{"cancelled", "WORKSPACE_REQUEST_CANCELLED", "native-workspace", func(p *authorities, a *approvals, c *clock, cancel context.CancelFunc) { cancel() }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, c, r := fixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			n.hook = func() { test.change(p, a, c, cancel) }
			result, err := s.Read(ctx, r)
			if result != nil || n.reads != 1 {
				t.Fatal("disclosed/retried")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
}
func TestListRevokedDescendantIsNotDisclosed(t *testing.T) {
	for _, store := range []string{"grant", "approval"} {
		t.Run(store, func(t *testing.T) {
			s, p, a, n, _, r := fixture(t)
			n.hook = func() {
				if store == "grant" {
					p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private", RestrictionSource: authority.OwnerRestrictionSource}}
				} else {
					a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
				}
			}
			result, err := s.List(context.Background(), listRequest(r))
			if result != nil || n.lists != 1 {
				t.Fatal("disclosed/retried")
			}
			source := "owner-restriction"
			if store == "approval" {
				source = "computer-policy"
			}
			expectFailure(t, err, "AUTHORITY_PATH_DENIED", source)
		})
	}
}
func TestCancellationDuringFinalLookup(t *testing.T) {
	s, _, a, n, _, r := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	a.hook = func() {
		calls++
		if calls == 2 {
			cancel()
		}
	}
	result, err := s.Read(ctx, r)
	if result != nil || n.reads != 1 {
		t.Fatal("disclosed/retried")
	}
	expectFailure(t, err, "WORKSPACE_REQUEST_CANCELLED", "native-workspace")
}
func TestNativeRefusalsRemainOneShot(t *testing.T) {
	for _, nativeErr := range []error{authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace"), errors.New("private path/helper diagnostics")} {
		s, _, _, n, _, r := fixture(t)
		n.err = nativeErr
		result, err := s.Read(context.Background(), r)
		if result != nil || n.reads != 1 {
			t.Fatal("disclosed/retried")
		}
		code := "WORKSPACE_HELPER_FAILED"
		if _, ok := nativeErr.(*authority.Failure); ok {
			code = "WORKSPACE_ROOT_CHANGED"
		}
		expectFailure(t, err, code, "native-workspace")
	}
	s, _, _, n, _, r := fixture(t)
	n.read = nil
	result, err := s.Read(context.Background(), r)
	if result != nil {
		t.Fatal("nil success")
	}
	expectFailure(t, err, "WORKSPACE_HELPER_FAILED", "native-workspace")
}
func TestListReturnsIndependentCorrelatedOutput(t *testing.T) {
	s, _, _, n, _, r := fixture(t)
	n.list.Truncated = true
	result, err := s.List(context.Background(), listRequest(r))
	if err != nil {
		t.Fatal(err)
	}
	n.list.Entries[0] = "changed"
	if result.Entries[0] != "readme" || !result.Truncated || result.CallID != r.CallID || n.lists != 1 || result.RelativePath != "." {
		t.Fatal("aliased/lost list output")
	}
}

func TestRevocationAtFinalSnapshotAdmissionCannotDisclose(t *testing.T) {
	for _, list := range []bool{false, true} {
		s, p, a, n, _, request := fixture(t)
		calls := 0
		a.hook = func() {
			calls++
			if calls == 2 {
				p.p = nil
			}
		}
		var err error
		if list {
			out, e := s.List(context.Background(), listRequest(request))
			err = e
			if out != nil {
				t.Fatal("revoked listing disclosed")
			}
		} else {
			out, e := s.Read(context.Background(), request)
			err = e
			if out != nil {
				t.Fatal("revoked bytes disclosed")
			}
		}
		expectFailure(t, err, "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store")
		if n.reads+n.lists != 1 {
			t.Fatal("native operation retried")
		}
	}
}

func TestChangedGrantExclusionKeepsItsOwnProvenance(t *testing.T) {
	s, p, _, n, _, request := fixture(t)
	p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/cache", RestrictionSource: authority.ComputerApprovalSource}}
	n.hook = func() {
		p.p.Grant.ExcludedPaths = append(p.p.Grant.ExcludedPaths, authority.Exclusion{WorkspaceID: "work", Path: "/work/private", RestrictionSource: authority.OwnerRestrictionSource})
	}
	result, err := s.List(context.Background(), listRequest(request))
	if result != nil || n.lists != 1 {
		t.Fatal("disclosed or repeated listing")
	}
	expectFailure(t, err, "AUTHORITY_PATH_DENIED", "owner-restriction")
}

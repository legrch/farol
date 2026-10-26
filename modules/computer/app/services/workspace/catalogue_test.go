package workspace

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Policy-only selected lease double. Native state and real Task/Chat are not
// proved here; native Store + fixed lease integration vectors live in infra.
type selectedAccess struct {
	access
	binding port.TaskBinding
}

func (a selectedAccess) Binding() port.TaskBinding { return a.binding }

type discoveryNative struct {
	reads []string
	lists []string
	read  func(port.ReadRequest) (*port.ReadResponse, error)
	list  func(port.ListRequest) (*port.ListResponse, error)
}

func (n *discoveryNative) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.reads = append(n.reads, r.RelativePath)
	if r.Range != nil {
		panic("bootstrap issued a ranged read")
	}
	if n.read != nil {
		return n.read(r)
	}
	return &port.ReadResponse{Text: "rules", Bytes: 5, SHA256: strings.Repeat("a", 64)}, nil
}
func (n *discoveryNative) List(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
	n.lists = append(n.lists, r.Workspace.WorkspaceID+":"+r.RelativePath)
	out := &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}}
	if n.list != nil {
		return n.list(r)
	}
	return out, nil
}

// Port double only: reuse injected binding/failure vectors. Native no-list
// behavior and child churn are covered by the root composition witness.
func (n *discoveryNative) Inspect(ctx context.Context, r port.ListRequest) (*port.DirectoryBinding, error) {
	out, err := n.List(ctx, r)
	if err != nil || out == nil {
		return nil, err
	}
	return out.Binding, nil
}

func discoveryFixture(t *testing.T) (*Service, *authorities, *approvals, *discoveryNative, *clock, CatalogueRequest) {
	t.Helper()
	_, p, a, _, c, r := fixture(t)
	n := &discoveryNative{}
	binding := port.TaskBinding{Identity: p.p.Grant.Identity, ParticipantID: r.ParticipantID, TurnID: r.TurnID}
	s, err := NewForExecution(selectedAccess{access: access{p: p, a: a}, binding: binding}, n, c)
	if err != nil {
		t.Fatal(err)
	}
	return s, p, a, n, c, CatalogueRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID}
}
func TestCatalogueSealedSubtreeIDsOnlyAndTwoCompletePasses(t *testing.T) {
	s, p, a, n, _, r := discoveryFixture(t)
	p.p.Grant.Workspaces = []authority.Scope{{WorkspaceID: "second", Root: "/second", Mode: authority.Subtree, Access: authority.ReadAccess}, {WorkspaceID: "exact", Root: "/exact", Mode: authority.Exact, Access: authority.ReadAccess, Paths: []string{"/exact/README.md"}}, p.p.Grant.Workspaces[0]}
	a.a.Workspaces = append(a.a.Workspaces, authority.ApprovedWorkspace{WorkspaceID: "second", Root: "/second", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "3"}}, authority.ApprovedWorkspace{WorkspaceID: "approval-only", Root: "/extra", Access: authority.ReadAccess})
	out, err := s.Catalogue(context.Background(), r)
	if err != nil || out == nil {
		t.Fatal(err)
	}
	if !slices.Equal(n.lists, []string{"second:.", "work:.", "second:.", "work:."}) || len(n.reads) != 0 || len(out.Workspaces) != 2 || out.Workspaces[0].WorkspaceID != "second" || out.Workspaces[1].WorkspaceID != "work" {
		t.Fatalf("wrong candidates/order: %#v %#v", out, n.lists)
	}
	if out.Consistency != "twice-checked current authority and physical roots; not an atomic filesystem snapshot" || out.Next != "Use the exact workspaceId with computer_workspace_bootstrap before working in that folder. Folder names and paths are not workspace IDs." || out.CallID != r.CallID || out.Generation != r.Generation || out.TurnID != r.TurnID {
		t.Fatal("lost labels/correlation")
	}
}
func TestCatalogueBoundsBeforeAnyNativeIO(t *testing.T) {
	for _, test := range []struct {
		name string
		ids  []string
	}{
		{"empty ID", []string{""}}, {"duplicate", []string{"work", "work"}}, {"over UTF16 bound", []string{strings.Repeat("😀", 61)}}, {"invalid UTF8", []string{string([]byte{255})}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, _, n, _, r := discoveryFixture(t)
			p.p.Grant.Workspaces = nil
			for _, id := range test.ids {
				p.p.Grant.Workspaces = append(p.p.Grant.Workspaces, authority.Scope{WorkspaceID: id, Root: "/work", Mode: authority.Subtree, Access: authority.ReadAccess})
			}
			out, err := s.Catalogue(context.Background(), r)
			if out != nil || len(n.lists) != 0 {
				t.Fatal("invalid catalogue reached IO")
			}
			expectFailure(t, err, "COMPUTER_WORKSPACE_CATALOGUE_INVALID", "contract")
		})
	}
	s, p, _, n, _, r := discoveryFixture(t)
	for i := 1; i < 33; i++ {
		p.p.Grant.Workspaces = append(p.p.Grant.Workspaces, authority.Scope{WorkspaceID: fmt.Sprint(i), Root: "/work", Mode: authority.Subtree})
	}
	out, err := s.Catalogue(context.Background(), r)
	if out != nil || len(n.lists) != 0 {
		t.Fatal("33 candidates reached IO")
	}
	expectFailure(t, err, "COMPUTER_WORKSPACE_CATALOGUE_INVALID", "contract")
	s, p, _, _, _, r = discoveryFixture(t)
	p.p.Grant.Workspaces = nil
	out, err = s.Catalogue(context.Background(), r)
	if err != nil || out == nil || out.Workspaces == nil || len(out.Workspaces) != 0 {
		t.Fatalf("empty catalogue: %v", err)
	}
}
func TestEmptyCatalogueStillRequiresCurrentFinalAuthority(t *testing.T) {
	for _, test := range []struct {
		name, code, source string
		change             func(*authorities, *approvals, *clock)
	}{
		{"expiry", "AUTHORITY_EXPIRED", "task-grant", func(_ *authorities, _ *approvals, c *clock) { c.now = c.now.Add(time.Hour) }},
		{"revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, _ *approvals, _ *clock) { p.p = nil }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(_ *authorities, a *approvals, _ *clock) { a.a.Generation++ }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, c, r := discoveryFixture(t)
			p.p.Grant.Workspaces = nil
			calls := 0
			p.hook = func() {
				calls++
				if calls == 2 {
					test.change(p, a, c)
				}
			}
			out, err := s.Catalogue(context.Background(), r)
			if out != nil || len(n.lists) != 0 {
				t.Fatal("stale empty catalogue disclosed")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
}
func TestCatalogueRefusalDiscardsEarlierRootsWithoutRetry(t *testing.T) {
	s, _, _, n, _, r := discoveryFixture(t)
	n.list = func(q port.ListRequest) (*port.ListResponse, error) {
		if len(n.lists) == 2 {
			return nil, authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")
		}
		return &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: q.RelativePath, Root: q.Workspace.Root, ApprovedRoot: q.Workspace.ApprovedRoot}}, nil
	}
	out, err := s.Catalogue(context.Background(), r)
	if out != nil || len(n.lists) != 2 {
		t.Fatal("partial catalogue or retry")
	}
	expectFailure(t, err, "WORKSPACE_ROOT_CHANGED", "native-workspace")
}
func TestDiscoveryRequiresSelectedExecutionAndMatchingCaller(t *testing.T) {
	for _, change := range []func(*CatalogueRequest){func(r *CatalogueRequest) { r.SessionID = "other" }, func(r *CatalogueRequest) { r.TaskID = "other" }, func(r *CatalogueRequest) { r.TaskEpoch++ }, func(r *CatalogueRequest) { r.ParticipantID = "other" }, func(r *CatalogueRequest) { r.TurnID = "other" }} {
		s, _, _, n, _, r := discoveryFixture(t)
		change(&r)
		out, err := s.Catalogue(context.Background(), r)
		if out != nil || len(n.lists) != 0 {
			t.Fatal("body selected trusted task")
		}
		expectFailure(t, err, "AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	s, _, _, n, _, r := discoveryFixture(t)
	r.OwnerID = "other"
	out, err := s.Catalogue(context.Background(), r)
	if out != nil || len(n.lists) != 0 {
		t.Fatal("body selected owner")
	}
	expectFailure(t, err, "AUTHORITY_OWNER_MISMATCH", "task-grant")
	s, _, _, _, _, r = discoveryFixture(t)
	s.selected = nil
	out, err = s.Catalogue(context.Background(), r)
	if out != nil {
		t.Fatal("default admitted catalogue")
	}
	expectFailure(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}

func TestNewForExecutionRejectsIncompleteBindingAndCapturesItOnce(t *testing.T) {
	for _, change := range []func(*port.TaskBinding){
		func(b *port.TaskBinding) { b.OwnerID = "" }, func(b *port.TaskBinding) { b.SessionID = "" }, func(b *port.TaskBinding) { b.TaskID = "" }, func(b *port.TaskBinding) { b.ParticipantID = "" }, func(b *port.TaskBinding) { b.TurnID = "" },
		func(b *port.TaskBinding) { b.OwnerID = strings.Repeat("x", 81) },
		func(b *port.TaskBinding) { b.TurnID = strings.Repeat("😀", 61) },
		func(b *port.TaskBinding) { b.SessionID = string([]byte{255}) },
	} {
		_, p, a, n, c, r := discoveryFixture(t)
		binding := port.TaskBinding{Identity: p.p.Grant.Identity, ParticipantID: r.ParticipantID, TurnID: r.TurnID}
		change(&binding)
		s, err := NewForExecution(selectedAccess{access: access{p: p, a: a}, binding: binding}, n, c)
		if s != nil {
			t.Fatal("incomplete binding admitted")
		}
		expectFailure(t, err, "AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	s, p, a, n, c, r := discoveryFixture(t)
	ordinary := New(access{p: p, a: a}, n, c)
	out, err := ordinary.Catalogue(context.Background(), r)
	if out != nil || len(n.lists) != 0 {
		t.Fatal("ordinary constructor inferred execution")
	}
	expectFailure(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	boot, err := ordinary.Bootstrap(context.Background(), bootstrapRequest(r, "."))
	if boot != nil || len(n.lists) != 0 {
		t.Fatal("ordinary constructor admitted bootstrap")
	}
	expectFailure(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	// The captured correlation cannot be changed by mutation of a copied value.
	binding := *s.selected
	binding.TurnID = "other"
	if out, err := s.Catalogue(context.Background(), r); err != nil || out == nil {
		t.Fatal("correlation value aliases caller")
	}
}
func TestCatalogueAccepts32CandidatesAndUTF16Boundary(t *testing.T) {
	s, p, a, n, _, r := discoveryFixture(t)
	p.p.Grant.Workspaces = nil
	a.a.Workspaces = nil
	for i := 0; i < 32; i++ {
		id := fmt.Sprint(i)
		if i == 0 {
			id = strings.Repeat("😀", 60)
		}
		p.p.Grant.Workspaces = append(p.p.Grant.Workspaces, authority.Scope{WorkspaceID: id, Root: "/work", Mode: authority.Subtree, Access: authority.ReadAccess})
		a.a.Workspaces = append(a.a.Workspaces, authority.ApprovedWorkspace{WorkspaceID: id, Root: "/work", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}})
	}
	out, err := s.Catalogue(context.Background(), r)
	if err != nil || out == nil || len(out.Workspaces) != 32 || len(n.lists) != 64 {
		t.Fatalf("boundary refused: %v", err)
	}
}
func TestCatalogueChangesBetweenCompletePassesDiscardCollection(t *testing.T) {
	s, p, _, n, _, r := discoveryFixture(t)
	calls := 0
	p.hook = func() {
		calls++
		if calls == 4 {
			p.p.Grant.Workspaces[0].Root = "/work/sub"
		}
	}
	out, err := s.Catalogue(context.Background(), r)
	if out != nil || len(n.lists) != 2 {
		t.Fatal("changed context collected")
	}
	expectFailure(t, err, "COMPUTER_WORKSPACE_CONTEXT_CHANGED", "contract")
}

func TestCatalogueRequiresInspectionRatherThanFallingBackToList(t *testing.T) {
	_, p, a, n, c, r := contextFixture(t)
	binding := port.TaskBinding{Identity: p.p.Grant.Identity, ParticipantID: r.ParticipantID, TurnID: r.TurnID}
	s, failure := NewForExecution(selectedAccess{access: access{p: p, a: a}, binding: binding}, n, c)
	if failure != nil {
		t.Fatal(failure)
	}
	n.list.Entries = []string{"unused"}
	out, err := s.Catalogue(context.Background(), CatalogueRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID})
	if out != nil || n.lists != 0 {
		t.Fatal("missing inspector fell back to enumeration")
	}
	expectFailure(t, err, "WORKSPACE_HELPER_FAILED", "native-workspace")
}

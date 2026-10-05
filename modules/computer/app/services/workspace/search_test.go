package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure authority/adapter doubles. No native filesystem or Task/Chat lifecycle
// claim follows from these tests.
type searchNative struct {
	*native
	calls      int
	request    port.SearchRequest
	result     *port.SearchResponse
	searchErr  error
	searchHook func()
}

func (n *searchNative) Search(ctx context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
	n.calls++
	n.ctx = ctx
	n.request = r
	if n.searchHook != nil {
		n.searchHook()
	}
	if n.searchErr != nil {
		return nil, n.searchErr
	}
	if n.result == nil {
		n.result = &port.SearchResponse{Binding: &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}, Matches: []port.SearchMatch{{Path: "README.md", Line: 2, Text: "# Known Markdown 🌊"}}}
	}
	return n.result, nil
}
func searchFixture(t *testing.T) (*Service, *authorities, *approvals, *searchNative, *clock, SearchRequest) {
	t.Helper()
	_, p, a, n, c, r := fixture(t)
	p.p.Grant.Capabilities = append(p.p.Grant.Capabilities, authority.Search)
	a.a.Capabilities = append(a.a.Capabilities, authority.Search)
	search := &searchNative{native: n}
	binding := port.TaskBinding{Identity: p.p.Grant.Identity, ParticipantID: r.ParticipantID, TurnID: r.TurnID}
	s, err := NewForExecution(selectedAccess{access: access{p: p, a: a}, binding: binding}, search, c)
	if err != nil {
		t.Fatal(err)
	}
	return s, p, a, search, c, SearchRequest{OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID, WorkspaceID: r.WorkspaceID, RelativePath: ".", Pattern: "Markdown"}
}
func TestSearchServiceDescriptorAndCorrelation(t *testing.T) {
	s, p, a, n, _, r := searchFixture(t)
	p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private", RestrictionSource: authority.OwnerRestrictionSource}}
	a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/cache"}}
	ctx := context.WithValue(context.Background(), struct{}{}, "same operation")
	out, err := s.Search(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if n.calls != 1 || n.reads != 0 || n.lists != 0 || n.ctx != ctx || n.request.Pattern != r.Pattern || n.request.Workspace.Root != "/work" || len(n.request.Workspace.DeniedPaths) != 2 || n.request.Workspace.ApprovedRoot.Inode != "2" {
		t.Fatalf("lost native binding: %+v", n)
	}
	if out.OwnerID != r.OwnerID || out.TaskEpoch != r.TaskEpoch || out.CallID != r.CallID || out.Generation != r.Generation || out.TurnID != r.TurnID || out.RelativePath != r.RelativePath || len(out.Matches) != 1 {
		t.Fatalf("lost correlation %+v", out)
	}
	out.Matches[0].Text = "changed"
	if n.result.Matches[0].Text == "changed" {
		t.Fatal("response aliases adapter")
	}
	n.request.Workspace.DeniedPaths[0] = "changed"
	if p.p.Grant.ExcludedPaths[0].Path != "/work/private" {
		t.Fatal("descriptor aliases policy")
	}
}
func TestSearchServiceInitialRefusals(t *testing.T) {
	for _, test := range []struct {
		name, code, source string
		change             func(*Service, *authorities, *approvals, *SearchRequest)
	}{
		{"unselected", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store", func(s *Service, _ *authorities, _ *approvals, _ *SearchRequest) { s.selected = nil }},
		{"owner", "AUTHORITY_OWNER_MISMATCH", "task-grant", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.OwnerID = "other" }},
		{"turn", "AUTHORITY_TASK_MISMATCH", "task-grant", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.TurnID = "other" }},
		{"epoch", "AUTHORITY_TASK_MISMATCH", "task-grant", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.TaskEpoch++ }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(_ *Service, _ *authorities, a *approvals, _ *SearchRequest) { a.a.Generation++ }},
		{"capability", "AUTHORITY_CAPABILITY_DENIED", "computer-policy", func(_ *Service, _ *authorities, a *approvals, _ *SearchRequest) { a.a.Capabilities = nil }},
		{"path", "COMPUTER_PATH_INVALID", "task-grant", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.RelativePath = "../escape" }},
		{"empty pattern", "WORKSPACE_INVALID_REQUEST", "contract", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.Pattern = "" }},
		{"invalid UTF8", "WORKSPACE_INVALID_REQUEST", "contract", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.Pattern = string([]byte{255}) }},
		{"UTF16 bound", "WORKSPACE_INVALID_REQUEST", "contract", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) {
			r.Pattern = strings.Repeat("🌊", 2049)
		}},
		{"control", "WORKSPACE_INVALID_REQUEST", "contract", func(_ *Service, _ *authorities, _ *approvals, r *SearchRequest) { r.Pattern = "bad\npattern" }},
		{"optional port", "WORKSPACE_HELPER_FAILED", "native-workspace", func(s *Service, _ *authorities, _ *approvals, _ *SearchRequest) { s.workspace = &native{} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, _, r := searchFixture(t)
			test.change(s, p, a, &r)
			out, err := s.Search(context.Background(), r)
			if out != nil || n.calls != 0 {
				t.Fatal("refusal reached native or disclosed")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
}
func TestSearchServiceFinalDisclosureRefusals(t *testing.T) {
	for _, test := range []struct {
		name, code, source string
		change             func(*authorities, *approvals, *clock)
	}{
		{"revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store", func(p *authorities, _ *approvals, _ *clock) { p.p = nil }},
		{"grant expiry", "AUTHORITY_EXPIRED", "task-grant", func(_ *authorities, _ *approvals, c *clock) { c.now = c.now.Add(time.Hour) }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(_ *authorities, a *approvals, _ *clock) { a.a.Generation++ }},
		{"native root identity", "WORKSPACE_ROOT_CHANGED", "native-workspace", func(_ *authorities, a *approvals, _ *clock) { a.a.Workspaces[0].RootIdentity.Inode = "3" }},
		{"new policy exclusion", "AUTHORITY_PATH_DENIED", "computer-policy", func(_ *authorities, a *approvals, _ *clock) {
			a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/README.md"}}
		}},
		{"new grant exclusion", "AUTHORITY_PATH_DENIED", "owner-restriction", func(p *authorities, _ *approvals, _ *clock) {
			p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/README.md", RestrictionSource: authority.OwnerRestrictionSource}}
		}},
		{"capability", "AUTHORITY_CAPABILITY_DENIED", "computer-policy", func(_ *authorities, a *approvals, _ *clock) { a.a.Capabilities = nil }},
		{"authority ID", "AUTHORITY_COMPUTER_MISMATCH", "computer-policy", func(p *authorities, _ *approvals, _ *clock) { p.p.Grant.AuthorityID = "new" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, p, a, n, c, r := searchFixture(t)
			n.searchHook = func() { test.change(p, a, c) }
			out, err := s.Search(context.Background(), r)
			if out != nil || n.calls != 1 {
				t.Fatal("stale bytes disclosed or retried")
			}
			expectFailure(t, err, test.code, test.source)
		})
	}
	s, _, _, n, _, r := searchFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	n.searchHook = cancel
	out, err := s.Search(ctx, r)
	if out != nil || n.calls != 1 {
		t.Fatal("cancelled result disclosed")
	}
	expectFailure(t, err, "WORKSPACE_REQUEST_CANCELLED", "native-workspace")
}
func TestSearchServiceNativeRefusalAndMalformedOutput(t *testing.T) {
	s, _, _, n, _, r := searchFixture(t)
	n.searchErr = errors.New("private host detail")
	out, err := s.Search(context.Background(), r)
	if out != nil || n.calls != 1 {
		t.Fatal("retried unknown")
	}
	expectFailure(t, err, "WORKSPACE_HELPER_FAILED", "native-workspace")
	for _, change := range []func(*port.SearchResponse){
		func(o *port.SearchResponse) { o.Binding = nil }, func(o *port.SearchResponse) { o.Binding.ApprovedRoot.Inode = "4" }, func(o *port.SearchResponse) { o.Matches[0].Path = "../escape" }, func(o *port.SearchResponse) { o.Matches[0].Line = 0 }, func(o *port.SearchResponse) { o.Matches[0].Text = "secret\nline" }, func(o *port.SearchResponse) { o.Matches[0].Text = string([]byte{255}) }, func(o *port.SearchResponse) { o.Matches[0].Text = strings.Repeat("🌊", 501) }, func(o *port.SearchResponse) { o.Matches = make([]port.SearchMatch, 101) },
	} {
		s, _, _, n, _, r := searchFixture(t)
		n.result = &port.SearchResponse{Binding: &port.DirectoryBinding{Root: "/work", RelativePath: ".", ApprovedRoot: port.Root{Path: "/work", Device: "1", Inode: "2"}}, Matches: []port.SearchMatch{{Path: "README.md", Line: 1, Text: "note"}}}
		change(n.result)
		out, err := s.Search(context.Background(), r)
		if out != nil {
			t.Fatal("malformed native bytes disclosed")
		}
		expectFailure(t, err, "WORKSPACE_HELPER_FAILED", "native-workspace")
	}
}
func TestSearchServiceExactFileAndIndependentPartialFlags(t *testing.T) {
	s, p, _, n, _, r := searchFixture(t)
	p.p.Grant.Workspaces[0].Mode = authority.Exact
	p.p.Grant.Workspaces[0].Paths = []string{"/work/README.md"}
	r.RelativePath = "README.md"
	n.result = &port.SearchResponse{Binding: &port.DirectoryBinding{Root: "/work", RelativePath: r.RelativePath, ApprovedRoot: port.Root{Path: "/work", Device: "1", Inode: "2"}}, Matches: []port.SearchMatch{}, ScanLimited: true}
	out, err := s.Search(context.Background(), r)
	if err != nil || out == nil || !out.ScanLimited || out.ResultLimited || out.Matches == nil || len(n.request.Workspace.ExactFilePaths) != 1 {
		t.Fatalf("exact/partial result %+v %v", out, err)
	}
	r.RelativePath = "."
	out, err = s.Search(context.Background(), r)
	if out != nil || n.calls != 1 {
		t.Fatal("exact grant widened")
	}
	expectFailure(t, err, "AUTHORITY_PATH_DENIED", "task-grant")
}

func TestSearchServiceSealsOutputBeforeDisclosureCallback(t *testing.T) {
	s, p, _, n, _, r := searchFixture(t)
	snapshots := 0
	p.hook = func() {
		snapshots++
		if snapshots == 3 {
			n.result.Matches[0].Path = "../escape"
			n.result.Matches[0].Text = "unvalidated"
			n.result.Binding.Root = "/other"
		}
	}
	out, err := s.Search(context.Background(), r)
	if err != nil || out == nil || out.Matches[0].Path != "README.md" || out.Matches[0].Text != "# Known Markdown 🌊" {
		t.Fatalf("aliased native output after validation: %+v %v", out, err)
	}
}

type searchExecutionLease struct {
	selectedAccess
	invalid bool
}

func (a *searchExecutionLease) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	if a.invalid {
		return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	return a.selectedAccess.WithSnapshot(ctx, id, inspect)
}
func TestSearchServiceInvalidatedExecutionLeaseRefusesFinalBytes(t *testing.T) {
	s, p, a, n, c, r := searchFixture(t)
	lease := &searchExecutionLease{selectedAccess: selectedAccess{access: access{p: p, a: a}, binding: *s.selected}}
	bound, err := NewForExecution(lease, n, c)
	if err != nil {
		t.Fatal(err)
	}
	n.searchHook = func() { lease.invalid = true }
	out, err := bound.Search(context.Background(), r)
	if out != nil || n.calls != 1 {
		t.Fatal("invalidated operation disclosed/retried")
	}
	expectFailure(t, err, "AUTHORITY_TASK_MISMATCH", "task-grant")
}

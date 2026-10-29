package boot

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type selfTestWorkspaceNative struct {
	*selfTestReadNative
	scanLimited bool
	afterSearch func()
}

func (n *selfTestWorkspaceNative) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	return nil, authority.Fail("WORKSPACE_NOT_FOUND", "native-workspace")
}
func (n *selfTestWorkspaceNative) Inspect(ctx context.Context, in port.ListRequest) (*port.DirectoryBinding, error) {
	return n.Workspace.(port.DirectoryInspector).Inspect(ctx, in)
}
func (n *selfTestWorkspaceNative) List(_ context.Context, in port.ListRequest) (*port.ListResponse, error) {
	return &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: in.RelativePath, Root: in.Workspace.Root, ApprovedRoot: in.Workspace.ApprovedRoot}, Entries: []string{"check.txt"}}, nil
}
func (n *selfTestWorkspaceNative) ListScratch(ctx context.Context, in port.ListRequest, _ port.ScratchReadBinding) (*port.ListResponse, error) {
	return n.List(ctx, in)
}
func (n *selfTestWorkspaceNative) Search(_ context.Context, in port.SearchRequest) (*port.SearchResponse, error) {
	if n.afterSearch != nil {
		n.afterSearch()
	}
	path := in.RelativePath
	if state.ScratchLeaf(path) {
		path += "/check.txt"
	}
	return &port.SearchResponse{Binding: &port.DirectoryBinding{RelativePath: in.RelativePath, Root: in.Workspace.Root, ApprovedRoot: in.Workspace.ApprovedRoot}, Matches: []port.SearchMatch{{Path: path, Line: 1, Text: "Farol self-test verified"}}, ScanLimited: n.scanLimited}, nil
}
func (n *selfTestWorkspaceNative) SearchScratch(ctx context.Context, in port.SearchRequest, _ port.ScratchReadBinding) (*port.SearchResponse, error) {
	return n.Search(ctx, in)
}

func TestDiagnosticSearchAdapterRejectsOtherPathsBeforeCallingNative(t *testing.T) {
	called := false
	native := &selfTestWorkspaceNative{afterSearch: func() { called = true }}
	binding := port.ScratchReadBinding{RunID: "00000000-0000-4000-8000-000000000001"}
	w := &selfTestSearchListWorkspace{search: native, workspace: "work", binding: binding}
	_, err := w.Search(context.Background(), port.SearchRequest{Workspace: port.Descriptor{WorkspaceID: "work"}, RelativePath: "."})
	if err == nil || called {
		t.Fatal("diagnostic search escaped its fixture", err, called)
	}
}

// Real connector/authority owners with injected native workspace and journal.
func TestSelfTestWorkspaceCallsAreBoundToCurrentConnector(t *testing.T) {
	s, run, _, _ := selfTestFileFixture(t)
	run.scratchIdentity = state.DirectoryIdentity{Device: "1", Inode: "10"}
	run.scratchCustody = &fileWorkspaceHold{}
	run.fixtureFileIdentity = state.DirectoryIdentity{Device: "1", Inode: "20"}
	run.fixtureCustody = &fileWorkspaceHold{}
	run.fixtureFileHash = selfTestFileHash(selfTestFileAfter)
	run.fixtureEditStarted, run.fixtureOperation = true, "original-edit"
	native := &selfTestWorkspaceNative{selfTestReadNative: &selfTestReadNative{Workspace: s.current.route.workspace}}
	s.current.route.workspace = native
	ids, _ := selfTestIDsV2(run.operation)
	plan := &connectorSelfTestPlan{connector: s, slot: s.current, workspace: run.workspace, ids: ids, run: run}
	for _, check := range []struct{ name, call string }{{"catalogue", ids.catalogue}, {"bootstrap", ids.bootstrap}, {"list", ids.list}, {"read", ids.read}} {
		out := plan.workspaceCheck(context.Background(), check.name, check.call)
		if out.Status != "pass" || out.Operation != check.call {
			t.Fatal("check failed", check.name, out)
		}
	}
	// Search has not been granted by this fixture. The diagnostic cannot widen it.
	for _, name := range []string{"search", "directory search"} {
		out := plan.workspaceCheck(context.Background(), name, ids.search)
		if out.Status != "fail" || out.Code != "AUTHORITY_CAPABILITY_DENIED" {
			t.Fatal("search authority widened", name, out)
		}
	}
}

func TestSelfTestSearchRejectsLimitedAndRevokedResults(t *testing.T) {
	for _, name := range []string{"search", "directory search"} {
		for _, scenario := range []string{"success", "limited", "withdraw"} {
			t.Run(name+"/"+scenario, func(t *testing.T) {
				s, access, native, _, input := newConnectorFixture(t)
				access.approval.Capabilities = []authority.Capability{authority.List, authority.Read, authority.Write, authority.Search}
				access.approval.Workspaces[0].Access = authority.WriteAccess
				access.PutApproval(access.approval)
				s.root.publication.approval = access.approval.Clone()
				deps, _, _ := chatMutationDependencies()
				var err error
				s.mutations, err = settingsMutationIngress(s.root, deps)
				if err != nil {
					t.Fatal(err)
				}
				wrapper := &selfTestWorkspaceNative{selfTestReadNative: &selfTestReadNative{Workspace: native}, scanLimited: scenario == "limited"}
				s.root.native = wrapper
				if _, err := s.Open(context.Background(), "open", input); err != nil {
					t.Fatal(err)
				}
				s.mutations.stageBaseline, s.mutations.stageOwner, s.mutations.stageLifetime = true, &computerStageOwner{}, context.Background()
				const runID = "00000000-0000-4000-8000-000000000001"
				run, err := s.mutations.beginSelfTestRun(context.Background(), runID, "work")
				if err != nil {
					t.Fatal(err)
				}
				run.scratchIdentity = state.DirectoryIdentity{Device: "1", Inode: "10"}
				run.scratchCustody = &fileWorkspaceHold{}
				run.fixtureFileIdentity = state.DirectoryIdentity{Device: "1", Inode: "20"}
				run.fixtureCustody = &fileWorkspaceHold{}
				run.fixtureFileHash, run.fixtureEditStarted, run.fixtureOperation = selfTestFileHash(selfTestFileAfter), true, "original-edit"
				s.mutations.operations[runID] = &settingsMutationOperation{workspace: "work", stageScratch: true, scratchCreated: true, settled: true, selfTestRun: run}
				if scenario == "withdraw" {
					wrapper.afterSearch = func() { access.approval.Generation++; access.PutApproval(access.approval) }
				}
				ids, _ := selfTestIDsV2(runID)
				plan := &connectorSelfTestPlan{connector: s, slot: s.current, workspace: "work", ids: ids, run: run}
				out := plan.workspaceCheck(context.Background(), name, ids.search)
				if scenario == "success" && out.Status != "pass" || scenario != "success" && out.Status == "pass" {
					t.Fatal("incorrect search result", scenario, out)
				}
				if scenario == "limited" && (out.Status != "unknown" || out.Code != "SELF_TEST_SCAN_LIMITED") {
					t.Fatal("limited search must remain unknown", out)
				}
			})
		}
	}
}

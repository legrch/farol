package boot

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	"golang.org/x/sys/unix"
)

type selfTestWorkspaceNative struct {
	*selfTestReadNative
	scanLimited bool
	afterSearch func()
}

// Real disposable filesystem and connector/authority contracts; custody and
// journal are injected. This is not live provider or process evidence.
func TestSelfTestDirectorySearchThroughConnectorOnDisposableFilesystem(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const runID = "00000000-0000-4000-8000-000000000001"
	leaf := state.ScratchPath(runID)
	dir, file := filepath.Join(root, leaf), filepath.Join(root, leaf, "check.txt")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(selfTestFileAfter), 0600); err != nil {
		t.Fatal(err)
	}
	identity := func(path string) state.DirectoryIdentity {
		t.Helper()
		var st unix.Stat_t
		if err := unix.Lstat(path, &st); err != nil {
			t.Fatal(err)
		}
		return state.DirectoryIdentity{Device: strconv.FormatUint(uint64(st.Dev), 10), Inode: strconv.FormatUint(st.Ino, 10)}
	}
	rootID, dirID, fileID := identity(root), identity(dir), identity(file)
	s, access, _, _, input := newConnectorFixture(t)
	access.approval.Capabilities = []authority.Capability{authority.List, authority.Read, authority.Write, authority.Search}
	access.approval.Workspaces[0].Access = authority.WriteAccess
	access.approval.Workspaces[0].Root = root
	access.approval.Workspaces[0].RootIdentity = authority.RootIdentity{Device: rootID.Device, Inode: rootID.Inode}
	access.PutApproval(access.approval)
	s.root.publication.approval = access.approval.Clone()
	s.root.native = filesystem.New(root + "-home")
	deps, _, _ := chatMutationDependencies()
	s.mutations, err = settingsMutationIngress(s.root, deps)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "open", input); err != nil {
		t.Fatal(err)
	}
	s.mutations.stageBaseline, s.mutations.stageOwner, s.mutations.stageLifetime = true, &computerStageOwner{}, context.Background()
	run, err := s.mutations.beginSelfTestRun(context.Background(), runID, "work")
	if err != nil {
		t.Fatal(err)
	}
	run.scratchIdentity, run.scratchCustody = dirID, &fileWorkspaceHold{}
	run.fixtureFileIdentity, run.fixtureCustody = fileID, &fileWorkspaceHold{}
	run.fixtureFileHash, run.fixtureEditStarted, run.fixtureOperation = selfTestFileHash(selfTestFileAfter), true, "original-edit"
	s.mutations.operations[runID] = &settingsMutationOperation{workspace: "work", stageScratch: true, scratchCreated: true, settled: true, selfTestRun: run}
	ids, _ := selfTestIDsV3(runID)
	plan := &connectorSelfTestPlan{connector: s, slot: s.current, workspace: "work", ids: ids, run: run}
	result := plan.workspaceCheck(context.Background(), "directory search", ids.directorySearch)
	if result.Status != "pass" || result.Operation != ids.directorySearch {
		t.Fatal("real scratch search failed", result)
	}
	if err := os.WriteFile(filepath.Join(dir, "unowned"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	result = plan.workspaceCheck(context.Background(), "directory search", ids.directorySearch+"-extra")
	if result.Status != "unknown" {
		t.Fatal("unexpected file accepted", result)
	}
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

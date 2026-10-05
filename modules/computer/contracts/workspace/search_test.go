package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Contract/application collaboration with external policy/native doubles only.
// This is not production transport, native filesystem or current-task evidence.
type searchContractClock struct{ now time.Time }

func (c searchContractClock) Now() time.Time { return c.now }

type searchContractAccess struct {
	p       *authority.Participant
	a       *authority.Approval
	binding port.TaskBinding
}

func (a *searchContractAccess) Binding() port.TaskBinding { return a.binding }
func (a *searchContractAccess) WithSnapshot(_ context.Context, _ string, inspect func(port.AccessSnapshot) error) error {
	return inspect(port.AccessSnapshot{Participant: a.p, Approval: a.a})
}

type searchContractNative struct {
	result  *port.SearchResponse
	err     error
	calls   int
	hook    func()
	request port.SearchRequest
}

func (*searchContractNative) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	panic("unexpected read")
}
func (*searchContractNative) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	panic("unexpected list")
}
func (n *searchContractNative) Search(_ context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
	n.calls++
	n.request = r
	if n.hook != nil {
		n.hook()
	}
	return n.result, n.err
}
func searchContractFixture(t *testing.T) (*Contract, *searchContractNative, *searchContractAccess, SearchRequest) {
	t.Helper()
	now := time.Unix(1000, 0)
	a := &authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Search}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	identity := authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 4}
	grant, err := authority.Derive(*a, authority.Admission{Identity: identity, AuthorityID: "grant", ComputerID: a.ComputerID, ComputerGeneration: a.Generation, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Search}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Minute)}}, now)
	if err != nil {
		t.Fatal(err)
	}
	p, err := authority.Create(*grant, authority.ParticipantAdmission{ParticipantID: "main", Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	access := &searchContractAccess{p: p, a: a, binding: port.TaskBinding{Identity: identity, ParticipantID: "main", TurnID: "turn"}}
	n := &searchContractNative{result: &port.SearchResponse{Binding: &port.DirectoryBinding{Root: "/work", RelativePath: ".", ApprovedRoot: port.Root{Path: "/work", Device: "1", Inode: "2"}}, Matches: []port.SearchMatch{{Path: "Note with spaces 🌊.md", Line: 2, Text: "# Known Markdown", Truncated: true}}, ResultLimited: true, ScanLimited: true}}
	service, err := workspacesvc.NewForExecution(access, n, searchContractClock{now})
	if err != nil {
		t.Fatal(err)
	}
	return New(service), n, access, SearchRequest{OwnerID: identity.OwnerID, SessionID: identity.SessionID, TaskID: identity.TaskID, TaskEpoch: identity.TaskEpoch, ParticipantID: "main", TurnID: "turn", Generation: 5, CallID: "call", WorkspaceID: "work", RelativePath: ".", Pattern: "Markdown"}
}
func TestSearchContractMapsIndependentResultsAndCorrelation(t *testing.T) {
	c, n, _, r := searchContractFixture(t)
	out, err := c.Search(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if out.OwnerID != r.OwnerID || out.SessionID != r.SessionID || out.TaskID != r.TaskID || out.TaskEpoch != r.TaskEpoch || out.ParticipantID != r.ParticipantID || out.TurnID != r.TurnID || out.Generation != r.Generation || out.CallID != r.CallID || out.WorkspaceID != r.WorkspaceID || out.RelativePath != r.RelativePath || !out.ResultLimited || !out.ScanLimited || !out.Matches[0].Truncated || out.Matches[0].Line != 2 || out.Matches[0].Path != n.result.Matches[0].Path || n.calls != 1 || n.request.Pattern != r.Pattern {
		t.Fatalf("mapping %+v", out)
	}
	out.Matches[0].Text = "changed"
	if n.result.Matches[0].Text == "changed" {
		t.Fatal("aliased contract result")
	}
	n.result.Matches = []port.SearchMatch{}
	n.result.ResultLimited = false
	n.result.ScanLimited = true
	out, err = c.Search(context.Background(), r)
	if err != nil || out.Matches == nil || len(out.Matches) != 0 || out.ResultLimited || !out.ScanLimited {
		t.Fatalf("lost empty partial: %+v %v", out, err)
	}
}
func TestSearchContractClassifiesFailuresWithoutRetry(t *testing.T) {
	for _, test := range []struct {
		native       error
		code, source string
	}{
		{errors.New("private diagnostic"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("WORKSPACE_RACE_DETECTED", "native-workspace"), "WORKSPACE_RACE_DETECTED", "native-workspace"},
		{authority.Fail("WORKSPACE_SEARCH_TIMEOUT", "native-workspace"), "WORKSPACE_SEARCH_TIMEOUT", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_TEXT", "native-workspace"), "WORKSPACE_NOT_TEXT", "native-workspace"},
		{authority.Fail("WORKSPACE_FILE_TOO_LARGE", "native-workspace"), "WORKSPACE_FILE_TOO_LARGE", "native-workspace"},
	} {
		c, n, _, r := searchContractFixture(t)
		n.err = test.native
		out, err := c.Search(context.Background(), r)
		var failure *Failure
		if out != nil || n.calls != 1 || !errors.As(err, &failure) || failure.Code != test.code || failure.Source != test.source || failure.Retry != "never" {
			t.Fatalf("unsafe refusal: %+v %v", out, err)
		}
	}
	c, n, a, r := searchContractFixture(t)
	n.hook = func() { a.a.Generation++ }
	out, err := c.Search(context.Background(), r)
	var failure *Failure
	if out != nil || !errors.As(err, &failure) || failure.Code != "AUTHORITY_COMPUTER_MISMATCH" || n.calls != 1 {
		t.Fatalf("stale disclosure: %+v %v", out, err)
	}
}

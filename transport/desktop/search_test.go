package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// CPU-only real policy and contract, with an injected filesystem boundary.
type searchCurrentFixture struct{ binding port.TaskBinding }

func (s searchCurrentFixture) WithCurrent(_ context.Context, inspect func(*port.TaskBinding) error) error {
	return inspect(&s.binding)
}

type searchNativeFixture struct {
	result port.SearchResponse
	calls  int
	after  func()
}

func (w *searchNativeFixture) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	panic("unexpected read")
}
func (w *searchNativeFixture) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	panic("unexpected list")
}
func (w *searchNativeFixture) Search(_ context.Context, in port.SearchRequest) (*port.SearchResponse, error) {
	w.calls++
	w.result.Binding = &port.DirectoryBinding{Root: in.Workspace.Root, RelativePath: in.RelativePath, ApprovedRoot: in.Workspace.ApprovedRoot}
	if w.after != nil {
		w.after()
	}
	return &w.result, nil
}
func searchFixture(t *testing.T) (Method, *searchNativeFixture, *accessrepo.Repository, wire.ComputerSearchRequest, *int) {
	t.Helper()
	now := time.UnixMilli(1791000000000)
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "workspace", Root: "/fixture", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Search}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	grant, err := authority.Derive(approval, authority.Admission{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 7, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "workspace", Root: "/fixture", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Search}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}}, now)
	if err != nil {
		t.Fatal(err)
	}
	participant, err := authority.Create(*grant, authority.ParticipantAdmission{ParticipantID: "participant", Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	access := accessrepo.New()
	access.PutApproval(approval)
	access.PutParticipant(*participant)
	native := &searchNativeFixture{result: port.SearchResponse{Matches: []port.SearchMatch{{Path: "日本語 with spaces.md", Line: 9007199254740991, Text: "🌊\tmatch", Truncated: true}}, ResultLimited: true, ScanLimited: true}}
	issuer, err := executionsvc.New(access, searchCurrentFixture{port.TaskBinding{Identity: participant.Grant.Identity, ParticipantID: participant.ParticipantID, TurnID: "turn"}}, readClock{at: now}, executionsvc.Ceiling{Participant: *participant, Approval: approval})
	if err != nil {
		t.Fatal(err)
	}
	calls := new(int)
	method := SearchMethod(func(ctx context.Context, in workspacect.SearchRequest) (*workspacect.Contract, error) {
		*calls++
		if in.TaskEpoch != 9007199254740993 || in.Generation != ^uint64(0) {
			t.Fatal("counter narrowed")
		}
		lease, err := issuer.Admit(ctx, authority.Search)
		if err != nil {
			var f *authority.Failure
			if errors.As(err, &f) {
				return nil, &workspacect.Failure{Code: f.Code, Source: f.Source, Retry: "never"}
			}
			return nil, err
		}
		service, err := workspacesvc.NewForExecution(lease, native, readClock{at: now})
		if err != nil {
			return nil, err
		}
		return workspacect.New(service), nil
	}, wire.Context{ProfileId: "profile", BackendGeneration: "backend"})
	request := wire.ComputerSearchRequest{OwnerId: "owner", SessionId: "session", TaskId: "task", TaskEpoch: "9007199254740993", ParticipantId: "participant", TurnId: "turn", Generation: "18446744073709551615", CallId: "call", WorkspaceId: "workspace", RelativePath: ".", Pattern: "match"}
	return method, native, access, request, calls
}
func TestSearchWireMapsExactBoundedMatchesAndPartialState(t *testing.T) {
	method, native, _, body, calls := searchFixture(t)
	out := invokeRead(t, method, body)
	var result wire.ComputerSearchResponse
	if out.Status != "ok" || wire.Validate("ComputerSearchResponse", out.Data) != nil || json.Unmarshal(out.Data, &result) != nil {
		t.Fatalf("invalid result %+v", out)
	}
	var matches []wire.ComputerSearchMatch
	if json.Unmarshal(result.Matches, &matches) != nil || len(matches) != 1 || matches[0].Path != native.result.Matches[0].Path || matches[0].Line != "9007199254740991" || !matches[0].Truncated || !result.ResultLimited || !result.ScanLimited || result.Pattern != body.Pattern || result.TaskEpoch != body.TaskEpoch || result.Generation != body.Generation || result.CallId != body.CallId || *calls != 1 || native.calls != 1 {
		t.Fatal("search lost identity/partial state")
	}
	native.result = port.SearchResponse{}
	out = invokeRead(t, method, body)
	if out.Status != "ok" || !strings.Contains(string(out.Data), `"matches":[]`) || !strings.Contains(string(out.Data), `"resultLimited":false`) || !strings.Contains(string(out.Data), `"scanLimited":false`) {
		t.Fatal("empty result not explicit")
	}
}
func TestSearchWireRefusesRevocationBeforeAndAfterNative(t *testing.T) {
	for _, late := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "after"}[late], func(t *testing.T) {
			method, native, access, body, _ := searchFixture(t)
			revoke := func() { access.RevokeParticipant("participant") }
			if late {
				native.after = revoke
			} else {
				revoke()
			}
			out := invokeRead(t, method, body)
			if out.Status != "refused" || out.Code != "COMPUTER_PARTICIPANT_NOT_FOUND" || wire.Validate("ComputerSearchRefusal", out.Data) != nil {
				t.Fatalf("revocation disclosed search %+v", out)
			}
			expected := 0
			if late {
				expected = 1
			}
			if native.calls != expected {
				t.Fatal("wrong native count")
			}
		})
	}
}
func TestSearchWireRejectsMalformedInputAndInvalidMatches(t *testing.T) {
	for _, body := range []string{`{}`, `{"ownerId":"owner","ownerId":"other"}`, `{"root":"/outside"}`} {
		method, native, _, _, calls := searchFixture(t)
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: json.RawMessage(body)})
		if err != nil || out.Status != "refused" || *calls != 0 || native.calls != 0 {
			t.Fatal("invalid body reached owner")
		}
	}
	for _, match := range []port.SearchMatch{
		{Path: "../private", Line: 1}, {Path: ".", Line: 1}, {Path: "/outside", Line: 1}, {Path: "file", Line: 0}, {Path: "file", Line: 9007199254740992},
		{Path: "file", Line: 1, Text: strings.Repeat("🌊", 501)}, {Path: "file", Line: 1, Text: "bad\nline"}, {Path: "file", Line: 1, Text: "\xff"},
	} {
		method, native, _, body, _ := searchFixture(t)
		native.result.Matches = []port.SearchMatch{match}
		raw, _ := json.Marshal(body)
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: raw})
		if err == nil && out != nil && out.Status == "ok" {
			t.Fatal("malformed match disclosed")
		}
		if native.calls != 1 {
			t.Fatal("invalid result repeated native search")
		}
	}
	method, native, _, body, calls := searchFixture(t)
	raw, _ := json.Marshal(body)
	out, err := method.Handle(context.Background(), Request{RequestID: "r", OperationID: "unexpected", Body: raw})
	if err != nil || out.Status != "refused" || *calls != 0 || native.calls != 0 {
		t.Fatal("effect operation ID reached Search")
	}

}
func TestSearchWireNeverResolvesAfterCancelOrFactoryUnknown(t *testing.T) {
	method, native, _, body, calls := searchFixture(t)
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := method.Handle(ctx, Request{RequestID: "r", Body: raw})
	if err != nil || out.Status != "refused" || *calls != 0 || native.calls != 0 {
		t.Fatal("cancel reached owner")
	}
	sentinel := errors.New("original admission unknown")
	attempts := 0
	method = SearchMethod(func(context.Context, workspacect.SearchRequest) (*workspacect.Contract, error) {
		attempts++
		return nil, sentinel
	}, wire.Context{ProfileId: "profile", BackendGeneration: "backend"})
	out, err = method.Handle(context.Background(), Request{RequestID: "r", Body: raw})
	if out != nil || err != sentinel || attempts != 1 {
		t.Fatal("factory unknown changed or retried")
	}
}

func TestSearchWireBoundsWholeEscapedResponse(t *testing.T) {
	method, native, _, body, _ := searchFixture(t)
	for i := 0; i < 100; i++ {
		native.result.Matches = append(native.result.Matches, port.SearchMatch{Path: strings.Repeat("<", 4000), Line: uint64(i + 1), Text: strings.Repeat("<", 500)})
	}
	native.result.Matches = native.result.Matches[1:]
	out := invokeRead(t, method, body)
	if out.Status != "refused" || out.Code != "output_bound" || strings.Contains(string(out.Data), "\\u003c") || native.calls != 1 {
		t.Fatal("oversized escaped matches disclosed", out.Status, out.Code)
	}
}

package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// CPU-only real policy and contract, with an injected filesystem boundary.
type listNativeFixture struct {
	result port.ListResponse
	calls  int
	after  func()
}

func (w *listNativeFixture) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	panic("unexpected read")
}
func (w *listNativeFixture) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	w.calls++
	if w.after != nil {
		w.after()
	}
	return &w.result, nil
}
func listFixture(t *testing.T) (Method, *listNativeFixture, *accessrepo.Repository, wire.ComputerListRequest, *int) {
	t.Helper()
	now := time.UnixMilli(1791000000000)
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "workspace", Root: "/fixture", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	grant, err := authority.Derive(approval, authority.Admission{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 7, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "workspace", Root: "/fixture", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}}, now)
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
	native := &listNativeFixture{result: port.ListResponse{Entries: []string{"AGENTS.md", "one space.md", "日本語.md", "folder/"}, Truncated: true}}
	contract := workspacect.New(workspacesvc.New(access, native, readClock{at: now}))
	calls := new(int)
	method := ListMethod(func(_ context.Context, in workspacect.ListRequest) (*workspacect.Contract, error) {
		*calls++
		if in.TaskEpoch != 9007199254740993 || in.Generation != ^uint64(0) {
			t.Fatal("counter narrowed")
		}
		return contract, nil
	}, wire.Context{ProfileId: "profile", BackendGeneration: "backend"})
	request := wire.ComputerListRequest{OwnerId: "owner", SessionId: "session", TaskId: "task", TaskEpoch: "9007199254740993", ParticipantId: "participant", TurnId: "turn", Generation: "18446744073709551615", CallId: "call", WorkspaceId: "workspace", RelativePath: "."}
	return method, native, access, request, calls
}
func TestListWireMapsExactBoundedNamesAndPartialState(t *testing.T) {
	method, native, _, body, calls := listFixture(t)
	out := invokeRead(t, method, body)
	var result wire.ComputerListResponse
	if out.Status != "ok" || wire.Validate("ComputerListResponse", out.Data) != nil || json.Unmarshal(out.Data, &result) != nil {
		t.Fatalf("invalid result %+v", out)
	}
	var entries []string
	if json.Unmarshal(result.Entries, &entries) != nil || !reflect.DeepEqual(entries, native.result.Entries) || !result.Truncated || result.TaskEpoch != body.TaskEpoch || result.Generation != body.Generation || result.CallId != body.CallId || *calls != 1 || native.calls != 1 {
		t.Fatal("list lost identity/partial state")
	}
	native.result = port.ListResponse{}
	out = invokeRead(t, method, body)
	if out.Status != "ok" || !strings.Contains(string(out.Data), `"entries":[]`) || strings.Contains(string(out.Data), `"truncated":true`) {
		t.Fatal("empty result not explicit")
	}
}
func TestListWireRefusesRevocationBeforeAndAfterNative(t *testing.T) {
	for _, late := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "after"}[late], func(t *testing.T) {
			method, native, access, body, _ := listFixture(t)
			revoke := func() { access.RevokeParticipant("participant") }
			if late {
				native.after = revoke
			} else {
				revoke()
			}
			out := invokeRead(t, method, body)
			if out.Status != "refused" || out.Code != "COMPUTER_PARTICIPANT_NOT_FOUND" || wire.Validate("ComputerListRefusal", out.Data) != nil {
				t.Fatalf("revocation disclosed list %+v", out)
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
func TestListWireRejectsMalformedInputAndInvalidEntries(t *testing.T) {
	for _, body := range []string{`{}`, `{"ownerId":"owner","ownerId":"other"}`, `{"root":"/outside"}`} {
		method, native, _, _, calls := listFixture(t)
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: json.RawMessage(body)})
		if err != nil || out.Status != "refused" || *calls != 0 || native.calls != 0 {
			t.Fatal("invalid body reached owner")
		}
	}
	for _, entries := range [][]string{{"../private"}, {"."}, {".."}, {"nested/file"}, {"a", "a/"}, {"bad\nname"}, {strings.Repeat("🌊", 64)}, {"\xff"}, make([]string, 501)} {
		method, native, _, body, _ := listFixture(t)
		native.result.Entries = entries
		raw, _ := json.Marshal(body)
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: raw})
		if err == nil || out != nil {
			t.Fatalf("malformed entries disclosed: %q", entries)
		}
	}
}
func TestListWireNeverResolvesAfterCancelOrFactoryUnknown(t *testing.T) {
	method, native, _, body, calls := listFixture(t)
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := method.Handle(ctx, Request{RequestID: "r", Body: raw})
	if err != nil || out.Status != "refused" || *calls != 0 || native.calls != 0 {
		t.Fatal("cancel reached owner")
	}
	sentinel := errors.New("original admission unknown")
	attempts := 0
	method = ListMethod(func(context.Context, workspacect.ListRequest) (*workspacect.Contract, error) {
		attempts++
		return nil, sentinel
	}, wire.Context{ProfileId: "profile", BackendGeneration: "backend"})
	out, err = method.Handle(context.Background(), Request{RequestID: "r", Body: raw})
	if out != nil || err != sentinel || attempts != 1 {
		t.Fatal("factory unknown changed or retried")
	}
}

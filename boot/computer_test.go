package boot

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

// Aggregate port doubles only: real Computer policy/leases and transport run,
// but no native Store, filesystem, Task/Chat journal or normal app is qualified.
type computerClockFixture struct{ now time.Time }

func (c *computerClockFixture) Now() time.Time { return c.now }

type computerCurrentFixture struct {
	binding *port.TaskBinding
	calls   int
}

func (c *computerCurrentFixture) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	c.calls++
	return inspect(c.binding)
}

type computerWorkspaceFixture struct {
	calls int
	after func()
}

func (w *computerWorkspaceFixture) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	w.calls++
	if w.after != nil {
		w.after()
	}
	return &port.ReadResponse{Text: "test", Bytes: 4, SHA256: strings.Repeat("a", 64)}, nil
}
func (w *computerWorkspaceFixture) List(_ context.Context, in port.ListRequest) (*port.ListResponse, error) {
	w.calls++
	if w.after != nil {
		w.after()
	}
	return &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: in.RelativePath, Root: in.Workspace.Root, ApprovedRoot: in.Workspace.ApprovedRoot}}, nil
}

func TestComputerRootListUsesCurrentSelectedOwner(t *testing.T) {
	for _, mode := range []string{"allowed", "wrong-turn", "revoked", "late-revoke", "expired", "no-list"} {
		t.Run(mode, func(t *testing.T) {
			capability := authority.List
			if mode == "no-list" {
				capability = authority.Read
			}
			route, access, current, native, clock, read := computerFixture(t, capability)
			body := wire.ComputerListRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: read.CallId, WorkspaceId: read.WorkspaceId, RelativePath: "."}
			switch mode {
			case "wrong-turn":
				body.TurnId = "other"
			case "revoked":
				current.binding = nil
			case "late-revoke":
				native.after = func() { access.RevokeParticipant("participant") }
			case "expired":
				native.after = func() { clock.now = clock.now.Add(16 * time.Second) }
			}
			method := route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})["computer.workspace.list"]
			out := computerInvoke(t, method, body)
			if mode == "allowed" {
				if out.Status != "ok" || native.calls != 1 {
					t.Fatalf("list unavailable: %+v", out)
				}
			} else {
				if out.Status != "refused" {
					t.Fatalf("invalid authority disclosed listing: %+v", out)
				}
				if mode != "late-revoke" && mode != "expired" && native.calls != 0 {
					t.Fatal("invalid selected owner reached native listing")
				}
			}
		})
	}
}
func computerFixture(t *testing.T, capabilities ...authority.Capability) (*ComputerRoute, *accessrepo.Repository, *computerCurrentFixture, *computerWorkspaceFixture, *computerClockFixture, wire.ComputerReadRequest) {
	t.Helper()
	return computerFixtureWithScopes(t, false, capabilities...)
}
func computerFixtureWithScopes(t *testing.T, empty bool, capabilities ...authority.Capability) (*ComputerRoute, *accessrepo.Repository, *computerCurrentFixture, *computerWorkspaceFixture, *computerClockFixture, wire.ComputerReadRequest) {
	t.Helper()
	clock := &computerClockFixture{now: time.UnixMilli(1700000000000)}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, ParticipantID: "participant", TurnID: "turn"}
	approval := authority.Approval{OwnerID: binding.OwnerID, ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/disposable", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: capabilities, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock.Now().Add(time.Hour)}
	scopes := []authority.Scope{{WorkspaceID: "work", Root: "/disposable", Mode: authority.Subtree, Access: authority.ReadAccess}}
	if empty {
		approval.Workspaces = nil
		scopes = nil
	}
	grant, err := authority.Derive(approval, authority.Admission{Identity: binding.Identity, AuthorityID: "authority", ComputerID: approval.ComputerID, ComputerGeneration: approval.Generation, Policy: authority.Policy{Workspaces: scopes, Capabilities: capabilities, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock.Now().Add(time.Hour)}}, clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	participant, err := authority.Create(*grant, authority.ParticipantAdmission{ParticipantID: binding.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	access := accessrepo.New()
	access.PutApproval(approval)
	access.PutParticipant(*participant)
	current := &computerCurrentFixture{binding: &binding}
	native := &computerWorkspaceFixture{}
	route, err := computerRoute(access, current, executionsvc.Ceiling{Participant: *participant, Approval: approval}, native, clock)
	if err != nil {
		t.Fatal(err)
	}
	body := wire.ComputerReadRequest{OwnerId: binding.OwnerID, SessionId: binding.SessionID, TaskId: binding.TaskID, TaskEpoch: "9007199254740993", ParticipantId: binding.ParticipantID, TurnId: binding.TurnID, Generation: "18446744073709551615", CallId: "call", WorkspaceId: "work", RelativePath: "note.md"}
	return route, access, current, native, clock, body
}
func computerInvoke(t *testing.T, method desktop.Method, body any) *desktop.Outcome {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	out, err := method.Handle(context.Background(), desktop.Request{RequestID: "request", Body: data})
	if err != nil {
		t.Fatal(err)
	}
	if out == nil {
		t.Fatal("missing outcome")
	}
	return out
}
func readComputerMethod(route *ComputerRoute) desktop.Method {
	return route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})["computer.workspace.read"]
}
func TestComputerRootRequiresConcreteNativeAndSelectedOwners(t *testing.T) {
	if _, err := ComputerForChat(nil, nil, executionsvc.Ceiling{}, nil); err == nil {
		t.Fatal("missing Chat owner admitted")
	}
	if _, err := ComputerForTask(nil, nil, executionsvc.Ceiling{}, nil); err == nil {
		t.Fatal("missing Task owner admitted")
	}
	_, _, _, _, _, body := computerFixture(t, authority.Read)
	var missing *ComputerRoute
	if out := computerInvoke(t, readComputerMethod(missing), body); out.Status != "refused" || out.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" {
		t.Fatalf("missing route: %+v", out)
	}
}
func TestComputerRootOperationLeaseAndExactSelectedOwner(t *testing.T) {
	route, _, current, native, _, body := computerFixture(t, authority.Read)
	for i := 0; i < 2; i++ {
		out := computerInvoke(t, readComputerMethod(route), body)
		if out.Status != "ok" {
			t.Fatalf("read: %+v", out)
		}
	}
	if native.calls != 2 || current.calls < 6 {
		t.Fatal("whole operation current-owner checks missing")
	}
	body.TurnId = "foreign-turn"
	out := computerInvoke(t, readComputerMethod(route), body)
	if out.Status != "refused" || out.Code != "AUTHORITY_TASK_MISMATCH" || native.calls != 2 {
		t.Fatal("body selected another owner")
	}
	current.binding = nil
	body.TurnId = "turn"
	out = computerInvoke(t, readComputerMethod(route), body)
	if out.Status != "refused" || native.calls != 2 {
		t.Fatal("missing current owner reactivated")
	}
}
func TestComputerRootRefusesMalformedBeforeOwnerGate(t *testing.T) {
	route, _, current, native, _, body := computerFixture(t, authority.Read)
	body.TaskEpoch = "01"
	out := computerInvoke(t, readComputerMethod(route), body)
	if out.Status != "refused" || current.calls != 0 || native.calls != 0 {
		t.Fatal("malformed request reached owning gate")
	}
}
func TestComputerRootRevocationAndFixedDeadlineWinDisclosure(t *testing.T) {
	for _, reason := range []string{"revoked", "deadline"} {
		t.Run(reason, func(t *testing.T) {
			route, access, _, native, clock, body := computerFixture(t, authority.Read)
			native.after = func() {
				if reason == "revoked" {
					access.RevokeParticipant("participant")
				} else {
					clock.now = clock.now.Add(authority.OrdinaryExecutionLifetime)
				}
			}
			out := computerInvoke(t, readComputerMethod(route), body)
			if out.Status != "refused" || len(out.Data) == 0 || native.calls != 1 {
				t.Fatalf("late admission disclosed: %+v", out)
			}
		})
	}
}
func TestComputerRootCatalogueUsesListWithoutInventingRead(t *testing.T) {
	route, _, _, native, _, read := computerFixture(t, authority.List)
	body := wire.ComputerCatalogueRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: read.CallId}
	method := route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})["computer.workspace.catalogue"]
	out := computerInvoke(t, method, body)
	if out.Status != "ok" || native.calls != 2 {
		t.Fatalf("list-only catalogue unavailable: %+v", out)
	}
	out = computerInvoke(t, readComputerMethod(route), read)
	if out.Status != "refused" || out.Code != "AUTHORITY_CAPABILITY_DENIED" || native.calls != 2 {
		t.Fatal("catalogue widened read permission")
	}
}

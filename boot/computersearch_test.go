package boot

import (
	"context"
	"encoding/json"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/transport/desktop"
	"testing"
	"time"
)

func (w *computerWorkspaceFixture) Search(_ context.Context, in port.SearchRequest) (*port.SearchResponse, error) {
	w.calls++
	if w.after != nil {
		w.after()
	}
	return &port.SearchResponse{Binding: &port.DirectoryBinding{Root: in.Workspace.Root, RelativePath: in.RelativePath, ApprovedRoot: in.Workspace.ApprovedRoot}, Matches: []port.SearchMatch{{Path: "note.md", Line: 1, Text: "match"}}}, nil
}
func TestComputerRootSearchUsesCurrentSelectedOwner(t *testing.T) {
	for _, mode := range []string{"allowed", "wrong-turn", "revoked", "late-revoke", "expired", "no-search"} {
		t.Run(mode, func(t *testing.T) {
			capability := authority.Search
			if mode == "no-search" {
				capability = authority.Read
			}
			route, access, current, native, clock, read := computerFixture(t, capability)
			body := wire.ComputerSearchRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: read.CallId, WorkspaceId: read.WorkspaceId, RelativePath: ".", Pattern: "match"}
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
			method := route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})["computer.workspace.search"]
			out := computerInvoke(t, method, body)
			if mode == "allowed" {
				if out.Status != "ok" || native.calls != 1 {
					t.Fatalf("search unavailable: %+v", out)
				}
			} else {
				if out.Status != "refused" {
					t.Fatalf("invalid authority disclosed searching: %+v", out)
				}
				if mode != "late-revoke" && mode != "expired" && native.calls != 0 {
					t.Fatal("invalid selected owner reached native searching")
				}
			}
		})
	}
}

func (w *settingsNativeFixture) Search(_ context.Context, in port.SearchRequest) (*port.SearchResponse, error) {
	w.calls++
	if w.after != nil {
		w.after()
	}
	return &port.SearchResponse{Binding: &port.DirectoryBinding{Root: in.Workspace.Root, RelativePath: in.RelativePath, ApprovedRoot: in.Workspace.ApprovedRoot}, Matches: []port.SearchMatch{{Path: "note.md", Line: 1, Text: "match"}}}, nil
}
func TestComputerConnectorSearchUsesOriginalOwner(t *testing.T) {
	s, j, native, _, in := newConnectorFixture(t)
	j.approval.Capabilities = append(j.approval.Capabilities, authority.Search)
	j.PutApproval(j.approval)
	s.root.publication.approval = j.approval.Clone()
	var methods map[string]desktop.Method
	original := s.start
	s.start = func(ctx context.Context, b wire.ComputerConnectorBinding, m map[string]desktop.Method) (connectorEndpoint, error) {
		methods = m
		return original(ctx, b, m)
	}
	opened, err := s.Open(context.Background(), "open-search", in)
	if err != nil {
		t.Fatal(err)
	}
	e := opened.Execution
	body := wire.ComputerSearchRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "search", WorkspaceId: "work", RelativePath: ".", Pattern: "match"}
	method, ok := methods["computer.workspace.search"]
	if !ok {
		t.Fatal("external endpoint omitted search")
	}
	result := computerInvoke(t, method, body)
	if result.Status != "ok" || native.calls != 1 || j.publications != 1 {
		t.Fatal("search bypassed original connector owner", result)
	}
	if s.root.chat != nil || len(s.root.tasks) != 0 || len(s.root.turns) != 0 {
		t.Fatal("search fabricated Chat/Task")
	}
	s.root.guard.deactivate()
	raw, _ := json.Marshal(body)
	result, err = method.Handle(context.Background(), desktop.Request{RequestID: "withdrawn", Body: raw})
	if (err == nil && (result == nil || result.Status == "ok")) || native.calls != 1 {
		t.Fatal("withdrawn owner executed search")
	}
	if err := s.Shutdown(); err != nil {
		t.Fatal(err)
	}
}

package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/pkg/ipc"
)

type readClock struct{ at time.Time }

func (c readClock) Now() time.Time { return c.at }

type readWorkspace struct {
	result  port.ReadResponse
	calls   int
	request port.ReadRequest
}

func (w *readWorkspace) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	w.calls++
	w.request = r
	return &w.result, nil
}
func (w *readWorkspace) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	panic("not used")
}

func readFixture(t *testing.T) (Method, *readWorkspace, *accessrepo.Repository, wire.ComputerReadRequest) {
	t.Helper()
	now := time.Date(2026, 10, 2, 20, 0, 0, 0, time.UTC)
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 17, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "workspace", Root: "/disposable", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	grant, err := authority.Derive(approval, authority.Admission{AuthorityID: "authority", Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, ComputerID: "computer", ComputerGeneration: 17, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "workspace", Root: "/disposable", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}}, now)
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
	native := &readWorkspace{result: port.ReadResponse{Text: "🌊", Bytes: 4, SHA256: strings.Repeat("a", 64)}}
	contract := workspacect.New(workspacesvc.New(access, native, readClock{at: now}))
	peer := wire.Context{ProfileId: "test", BackendGeneration: "generation"}
	body := wire.ComputerReadRequest{OwnerId: "owner", SessionId: "session", TaskId: "task", TaskEpoch: "9007199254740993", ParticipantId: "participant", TurnId: "turn", Generation: "18446744073709551615", CallId: "call", WorkspaceId: "workspace", RelativePath: "note.md"}
	return ReadMethod(contract, peer), native, access, body
}
func invokeRead(t *testing.T, method Method, body any) *Outcome {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: data})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func TestReadMapsExactCorrelationAndUint64(t *testing.T) {
	method, native, _, body := readFixture(t)
	body.Range = &wire.ComputerReadRange{Offset: "18446744073709551615", Length: 4}
	next := uint64(math.MaxUint64)
	native.result = port.ReadResponse{Text: "🌊", Bytes: math.MaxUint64, Page: &port.Page{Offset: math.MaxUint64, Size: math.MaxUint64, NextOffset: &next}}
	out := invokeRead(t, method, body)
	if out.Status != "ok" || wire.Validate("ComputerReadResponse", out.Data) != nil {
		t.Fatalf("wrong response %s", out.Data)
	}
	var result wire.ComputerReadResponse
	if err := json.Unmarshal(out.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.OwnerId != body.OwnerId || result.SessionId != body.SessionId || result.TaskId != body.TaskId || result.TaskEpoch != body.TaskEpoch || result.ParticipantId != body.ParticipantId || result.TurnId != body.TurnId || result.Generation != body.Generation || result.CallId != body.CallId || result.WorkspaceId != body.WorkspaceId || result.RelativePath != body.RelativePath {
		t.Fatal("correlation lost")
	}
	if result.Bytes != "18446744073709551615" || result.Page == nil || result.Page.Offset != body.Range.Offset || result.Page.Size != body.Range.Offset || result.Page.NextOffset == nil || *result.Page.NextOffset != body.Range.Offset || native.request.Range.Offset != math.MaxUint64 {
		t.Fatal("uint64 precision lost")
	}
}
func TestReadRefusalPreservesOwnerSourceAndRetry(t *testing.T) {
	for _, mode := range []string{"escape", "revoked", "owner"} {
		t.Run(mode, func(t *testing.T) {
			method, native, access, body := readFixture(t)
			code, source := "COMPUTER_PATH_INVALID", "task-grant"
			switch mode {
			case "escape":
				body.RelativePath = "../private"
			case "revoked":
				access.RevokeParticipant("participant")
				code, source = "COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store"
			case "owner":
				body.OwnerId = "other"
				code, source = "AUTHORITY_OWNER_MISMATCH", "task-grant"
			}
			out := invokeRead(t, method, body)
			var refused wire.ComputerReadRefusal
			if err := json.Unmarshal(out.Data, &refused); err != nil {
				t.Fatal(err)
			}
			if out.Status != "refused" || refused.Code != code || refused.Source != source || refused.Retry != "never" || refused.Request == nil || *refused.Request != body || native.calls != 0 {
				t.Fatalf("wrong refusal %+v, calls %d", refused, native.calls)
			}
		})
	}
}
func TestReadRejectsMalformedTypedBodiesBeforeOwner(t *testing.T) {
	method, native, _, body := readFixture(t)
	raw, _ := json.Marshal(body)
	for _, data := range [][]byte{[]byte(`{}`), bytes.Replace(raw, []byte(`"9007199254740993"`), []byte(`9007199254740993`), 1), bytes.Replace(raw, []byte(`"9007199254740993"`), []byte(`"18446744073709551616"`), 1), bytes.Replace(raw, []byte(`"ownerId":"owner"`), []byte(`"ownerId":"owner","root":"/private"`), 1), []byte(`{"ownerId":"owner","ownerId":"other"}`)} {
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: data})
		if err != nil || out.Status != "refused" || out.Code != "invalid_read_request" || wire.Validate("ComputerReadRefusal", out.Data) != nil {
			t.Fatalf("wrong malformed refusal %v %+v", err, out)
		}
	}
	for _, length := range []uint32{0, 3, 262145} {
		body.Range = &wire.ComputerReadRange{Offset: "0", Length: length}
		if invokeRead(t, method, body).Code != "invalid_read_request" {
			t.Fatal("unbounded length accepted")
		}
	}
	if native.calls != 0 {
		t.Fatal("malformed body reached Computer")
	}
}
func TestEscapedReadOutputIsTypedRefusalBeforeFrameWrite(t *testing.T) {
	method, native, _, body := readFixture(t)
	native.result.Text = strings.Repeat("<", 262144)
	native.result.Bytes = 262144
	data, _ := json.Marshal(body)
	server, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{"computer.workspace.read": method}})
	if err != nil {
		t.Fatal(err)
	}
	var input, output bytes.Buffer
	for _, req := range []wire.Request{
		{Jsonrpc: "2.0", Id: "h", Method: "core.handshake", Params: wire.Call{Body: json.RawMessage(`{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`)}},
		{Jsonrpc: "2.0", Id: "r", Method: "computer.workspace.read", Params: wire.Call{Context: &wire.Context{ProfileId: "test", BackendGeneration: "generation"}, Body: data}},
		{Jsonrpc: "2.0", Id: "s", Method: "core.status", Params: wire.Call{Context: &wire.Context{ProfileId: "test", BackendGeneration: "generation"}, Body: json.RawMessage(`{}`)}},
	} {
		encoded, _ := json.Marshal(req)
		if err := ipc.WriteFrame(&input, encoded); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.Serve(context.Background(), io.NopCloser(&input), readWriter{Writer: &output}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		raw, err := ipc.ReadFrame(&output)
		if err != nil {
			t.Fatal(err)
		}
		var response wire.Response
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			var refused wire.ComputerReadRefusal
			if err := json.Unmarshal(response.Result.Data, &refused); err != nil {
				t.Fatal(err)
			}
			if response.Result.Status != "refused" || refused.Code != "output_bound" || refused.Source != "transport" || refused.Retry != "never" || refused.Request == nil || strings.Contains(string(raw), `\u003c`) {
				t.Fatalf("wrong bounded response %s", raw)
			}
		} else if response.Result.Status != "ok" {
			t.Fatal("pipe was not preserved")
		}
	}
	if native.calls != 1 {
		t.Fatal("read retried")
	}
}

type readWriter struct{ io.Writer }

func (readWriter) Close() error { return nil }

// Equivalent integer spellings must survive both schema bounds and the generated
// nested range decoder; uint64 decimal-string fields are never normalized.
func TestReadRangeIntegerSpellings(t *testing.T) {
	for _, number := range []string{"4", "4.0", "4e0", "40e-1", "262144", "2.62144e5"} {
		method, native, _, body := readFixture(t)
		encoded, _ := json.Marshal(body)
		raw := append(append([]byte{}, encoded[:len(encoded)-1]...), []byte(`,"range":{"offset":"9007199254740993","length":`+number+`}}`)...)
		if err := wire.Validate("ComputerReadRequest", raw); err != nil {
			t.Fatalf("%s: %v", number, err)
		}
		var decoded wire.ComputerReadRequest
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("typed %s: %v", number, err)
		}
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: raw})
		if err != nil || out.Status != "ok" || native.request.Range.Offset != 9007199254740993 || native.request.Range.Length != decoded.Range.Length {
			t.Fatalf("%s: %v %+v", number, err, out)
		}
	}
	for _, number := range []string{"3.0", "262145e0", "4.5", "1e1000", "-4"} {
		raw := []byte(`{"offset":"0","length":` + number + `}`)
		var decoded wire.ComputerReadRange
		if wire.Validate("ComputerReadRange", raw) == nil || json.Unmarshal(raw, &decoded) == nil {
			t.Fatalf("admitted %s", number)
		}
	}
}

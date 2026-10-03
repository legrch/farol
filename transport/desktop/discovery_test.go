package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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
	"github.com/legrch/farol/pkg/ipc"
)

var discoveryPeer = wire.Context{ProfileId: "test", BackendGeneration: "generation"}

func discoveryBodies() (wire.ComputerCatalogueRequest, wire.ComputerBootstrapRequest) {
	catalogue := wire.ComputerCatalogueRequest{OwnerId: "owner", SessionId: "session", TaskId: "task", TaskEpoch: "9007199254740993", ParticipantId: "participant", TurnId: "turn", Generation: "18446744073709551615", CallId: "call"}
	bootstrap := wire.ComputerBootstrapRequest{OwnerId: catalogue.OwnerId, SessionId: catalogue.SessionId, TaskId: catalogue.TaskId, TaskEpoch: catalogue.TaskEpoch, ParticipantId: catalogue.ParticipantId, TurnId: catalogue.TurnId, Generation: catalogue.Generation, CallId: catalogue.CallId, WorkspaceId: "workspace", RelativeDirectory: "a/b"}
	return catalogue, bootstrap
}
func discoveryJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func discoveryMethods(selectContract func(context.Context) (*workspacect.Contract, error)) []Method {
	return []Method{
		CatalogueMethod(func(ctx context.Context, _ workspacect.CatalogueRequest) (*workspacect.Contract, error) {
			return selectContract(ctx)
		}, discoveryPeer),
		BootstrapMethod(func(ctx context.Context, _ workspacect.BootstrapRequest) (*workspacect.Contract, error) {
			return selectContract(ctx)
		}, discoveryPeer),
	}
}

func TestDiscoveryParseAndCancellationBeforeFactory(t *testing.T) {
	catalogue, bootstrap := discoveryBodies()
	for i, body := range []any{catalogue, bootstrap} {
		calls := 0
		sentinel := errors.New("factory outcome unknown")
		method := discoveryMethods(func(context.Context) (*workspacect.Contract, error) { calls++; return nil, sentinel })[i]
		raw := discoveryJSON(t, body)
		invalid := [][]byte{[]byte(`{}`), bytes.Replace(raw, []byte(`"9007199254740993"`), []byte(`9007199254740993`), 1), bytes.Replace(raw, []byte(`"9007199254740993"`), []byte(`"01"`), 1), bytes.Replace(raw, []byte(`"18446744073709551615"`), []byte(`"18446744073709551616"`), 1), bytes.Replace(raw, []byte(`"ownerId":"owner"`), []byte(`"ownerId":"owner","ownerId":"other"`), 1), append(append([]byte{}, raw...), []byte(` {}`)...), bytes.Replace(raw, []byte(`"owner"`), []byte(`"\ud800"`), 1)}
		for _, field := range []string{"root", "approvedRoot", "grants", "home", "positiveAdmission"} {
			invalid = append(invalid, append(append([]byte{}, raw[:len(raw)-1]...), []byte(fmt.Sprintf(`,"%s":{}}`, field))...))
		}
		for _, data := range invalid {
			out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: data})
			if err != nil || out == nil || out.Status != "refused" || calls != 0 {
				t.Fatalf("invalid body reached factory: %v %+v calls=%d", err, out, calls)
			}
			name := []string{"ComputerCatalogueRefusal", "ComputerBootstrapRefusal"}[i]
			if wire.Validate(name, out.Data) != nil {
				t.Fatal("malformed typed refusal")
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		out, err := method.Handle(ctx, Request{RequestID: "r", Body: raw})
		if err != nil || out.Code != "WORKSPACE_REQUEST_CANCELLED" || calls != 0 {
			t.Fatal("cancelled request selected a contract")
		}
		for _, request := range []Request{{RequestID: "bad id", Body: raw}, {RequestID: "r", OperationID: "effect", Body: raw}} {
			if _, err := method.Handle(context.Background(), request); err == nil || calls != 0 {
				t.Fatal("bad envelope selected a contract")
			}
		}
		for n := 0; n < 2; n++ {
			out, err = method.Handle(context.Background(), Request{RequestID: fmt.Sprintf("r%d", n), Body: raw})
			if out != nil || err != sentinel || calls != n+1 {
				t.Fatal("factory failure was rewritten, cached or replayed")
			}
		}
	}
}

func TestDiscoveryFactoryRefusalsAndUnknownRemainDistinct(t *testing.T) {
	catalogue, bootstrap := discoveryBodies()
	for i, body := range []any{catalogue, bootstrap} {
		for _, failure := range []error{&workspacect.Failure{Code: "AUTHORITY_EXPIRED", Source: "task-grant", Retry: "never"}, fmt.Errorf("wrapped: %w", &workspacect.Failure{Code: "AUTHORITY_TASK_MISMATCH", Source: "task-admission", Retry: "never"}), &workspacect.Failure{Code: "AUTHORITY_EXPIRED", Source: "task-grant", Retry: "later"}, &workspacect.Failure{Code: "AUTHORITY_EXPIRED", Source: "unclassified", Retry: "never"}, errors.New("unclassified selection outcome")} {
			calls := 0
			method := discoveryMethods(func(context.Context) (*workspacect.Contract, error) { calls++; return nil, failure })[i]
			out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: discoveryJSON(t, body)})
			var typed *workspacect.Failure
			known := errors.As(failure, &typed) && typed.Retry == "never" && typed.Source != "unclassified"
			if calls != 1 {
				t.Fatal("factory replayed")
			}
			if !known {
				if out != nil || err != failure {
					t.Fatal("unknown failure became a refusal")
				}
				continue
			}
			if err != nil || out.Status != "refused" || out.Code != typed.Code {
				t.Fatal("known refusal lost")
			}
			var refused struct {
				Request             json.RawMessage
				Code, Source, Retry string
			}
			if json.Unmarshal(out.Data, &refused) != nil || refused.Code != typed.Code || refused.Source != typed.Source || refused.Retry != "never" || !bytes.Equal(refused.Request, discoveryJSON(t, body)) {
				t.Fatal("refusal correlation/source lost")
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		calls := 0
		method := discoveryMethods(func(context.Context) (*workspacect.Contract, error) { calls++; cancel(); return nil, nil })[i]
		out, err := method.Handle(ctx, Request{RequestID: "r", Body: discoveryJSON(t, body)})
		if err != nil || out.Code != "WORKSPACE_REQUEST_CANCELLED" || calls != 1 {
			t.Fatal("cancellation after selection lost")
		}
	}
}

// In-memory access and workspace doubles only. No native filesystem, process,
// provider, production owner or durable fixed lease is qualified by this fixture.
type discoveryAccess struct {
	*accessrepo.Repository
	binding port.TaskBinding
}

func (a discoveryAccess) Binding() port.TaskBinding { return a.binding }

type discoveryClock struct{ at time.Time }

func (c discoveryClock) Now() time.Time { return c.at }

type discoveryWorkspace struct{ reads, lists int }

func (n *discoveryWorkspace) List(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
	n.lists++
	return &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}}, nil
}
func (n *discoveryWorkspace) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.reads++
	switch r.RelativePath {
	case "AGENTS.md":
		return &port.ReadResponse{Text: "🌊", Bytes: 4, SHA256: strings.Repeat("a", 64)}, nil
	case "a/AGENTS.md":
		return nil, authority.Fail("WORKSPACE_NOT_FOUND", "native-workspace")
	case "a/b/AGENTS.md":
		return nil, authority.Fail("WORKSPACE_NOT_TEXT", "native-workspace")
	default:
		return nil, errors.New("unexpected instruction path")
	}
}
func discoveryContract(t *testing.T) (*workspacect.Contract, *discoveryWorkspace) {
	t.Helper()
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 17, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "workspace", Root: "/disposable", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "18446744073709551615", Inode: "9007199254740993"}}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}
	grant, err := authority.Derive(approval, authority.Admission{AuthorityID: "authority", Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993}, ComputerID: "computer", ComputerGeneration: 17, Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "workspace", Root: "/disposable", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read, authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: now.Add(time.Hour)}}, now)
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
	native := &discoveryWorkspace{}
	selected := discoveryAccess{Repository: access, binding: port.TaskBinding{Identity: grant.Identity, ParticipantID: "participant", TurnID: "turn"}}
	service, err := workspacesvc.NewForExecution(selected, native, discoveryClock{at: now})
	if err != nil {
		t.Fatal(err)
	}
	return workspacect.New(service), native
}

func TestDiscoveryOwningContractMapsExactCorrelationAndVariants(t *testing.T) {
	catalogue, bootstrap := discoveryBodies()
	for i, body := range []any{catalogue, bootstrap} {
		contract, native := discoveryContract(t)
		calls := 0
		method := discoveryMethods(func(context.Context) (*workspacect.Contract, error) { calls++; return contract, nil })[i]
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: discoveryJSON(t, body)})
		if err != nil || out == nil || out.Status != "ok" || calls != 1 {
			t.Fatalf("%d: %v %+v selections=%d", i, err, out, calls)
		}
		var result map[string]json.RawMessage
		if json.Unmarshal(out.Data, &result) != nil {
			t.Fatal("invalid data")
		}
		var expected map[string]json.RawMessage
		if json.Unmarshal(discoveryJSON(t, body), &expected) != nil {
			t.Fatal("invalid fixture")
		}
		for key, value := range expected {
			if !bytes.Equal(value, result[key]) {
				t.Fatalf("lost %s", key)
			}
		}
		if i == 0 {
			var entries []wire.ComputerCatalogueEntry
			if json.Unmarshal(result["workspaces"], &entries) != nil || len(entries) != 1 || entries[0].WorkspaceId != "workspace" || entries[0].Root != "/disposable" || entries[0].ApprovedRoot.Device != "18446744073709551615" || entries[0].ApprovedRoot.Inode != "9007199254740993" || native.reads != 0 || native.lists != 2 {
				t.Fatal("catalogue mapping or defined two-pass observation lost")
			}
		} else {
			var instructions []map[string]any
			if json.Unmarshal(result["instructions"], &instructions) != nil || len(instructions) != 3 || instructions[0]["status"] != "read" || instructions[0]["text"] != "🌊" || instructions[0]["bytes"] != "4" || instructions[1]["status"] != "not_found" || instructions[2]["status"] != "unavailable" || instructions[2]["code"] != "WORKSPACE_NOT_TEXT" || string(result["complete"]) != "false" || native.reads != 6 || native.lists != 2 {
				t.Fatal("closed instruction facts/boolean or defined two-pass observation lost")
			}
		}
	}
}

func discoveryResults() (workspacect.CatalogueRequest, workspacect.CatalogueResponse, workspacect.BootstrapRequest, workspacect.BootstrapResponse) {
	input := workspacect.CatalogueRequest{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 9007199254740993, ParticipantID: "participant", TurnID: "turn", Generation: math.MaxUint64, CallID: "call"}
	catalogue := workspacect.CatalogueResponse{OwnerID: input.OwnerID, SessionID: input.SessionID, TaskID: input.TaskID, TaskEpoch: input.TaskEpoch, ParticipantID: input.ParticipantID, TurnID: input.TurnID, Generation: input.Generation, CallID: input.CallID, Consistency: "twice-checked", Next: "bootstrap"}
	selected := workspacect.BootstrapRequest{OwnerID: input.OwnerID, SessionID: input.SessionID, TaskID: input.TaskID, TaskEpoch: input.TaskEpoch, ParticipantID: input.ParticipantID, TurnID: input.TurnID, Generation: input.Generation, CallID: input.CallID, WorkspaceID: "workspace", RelativeDirectory: "a/b"}
	bootstrap := workspacect.BootstrapResponse{OwnerID: input.OwnerID, SessionID: input.SessionID, TaskID: input.TaskID, TaskEpoch: input.TaskEpoch, ParticipantID: input.ParticipantID, TurnID: input.TurnID, Generation: input.Generation, CallID: input.CallID, WorkspaceID: selected.WorkspaceID, RelativeDirectory: selected.RelativeDirectory, Root: "/disposable", ApprovedRoot: workspacect.Root{Path: "/disposable", Device: "1", Inode: "2"}, Scope: "subtree", Complete: true, Coverage: "selected chain", Consistency: "twice-read", Precedence: "root first"}
	return input, catalogue, selected, bootstrap
}
func TestDiscoveryRejectsEveryCrossedCorrelationAndNilOutput(t *testing.T) {
	input, catalogue, selected, bootstrap := discoveryResults()
	for _, field := range []string{"OwnerID", "SessionID", "TaskID", "TaskEpoch", "ParticipantID", "TurnID", "Generation", "CallID", "WorkspaceID", "RelativeDirectory"} {
		crossed := bootstrap
		value := reflect.ValueOf(&crossed).Elem().FieldByName(field)
		if value.Kind() == reflect.String {
			value.SetString(value.String() + "-crossed")
		} else {
			value.SetUint(value.Uint() ^ 1)
		}
		if _, err := bootstrapResult(selected, &crossed); err == nil {
			t.Fatalf("bootstrap disclosed crossed %s", field)
		}
		if field == "WorkspaceID" || field == "RelativeDirectory" {
			continue
		}
		crossedCatalogue := catalogue
		value = reflect.ValueOf(&crossedCatalogue).Elem().FieldByName(field)
		if value.Kind() == reflect.String {
			value.SetString(value.String() + "-crossed")
		} else {
			value.SetUint(value.Uint() ^ 1)
		}
		if _, err := catalogueResult(input, &crossedCatalogue); err == nil {
			t.Fatalf("catalogue disclosed crossed %s", field)
		}
	}
	if _, err := catalogueResult(input, nil); err == nil {
		t.Fatal("nil catalogue disclosed")
	}
	if _, err := bootstrapResult(selected, nil); err == nil {
		t.Fatal("nil bootstrap disclosed")
	}
}

func TestDiscoveryInstructionClosureAndDecimalPrecision(t *testing.T) {
	mapped, err := discoveryInstruction(workspacect.ReadInstruction{RelativePath: "AGENTS.md", Text: "🌊", Bytes: math.MaxUint64})
	if err != nil || !bytes.Contains(mapped, []byte(`"bytes":"18446744073709551615"`)) {
		t.Fatal("uint64 precision lost")
	}
	for _, instruction := range []workspacect.Instruction{nil, (*workspacect.ReadInstruction)(nil), struct{ workspacect.Instruction }{}, workspacect.UnavailableInstruction{RelativePath: "AGENTS.md", Code: "unclassified"}, workspacect.ReadInstruction{RelativePath: "AGENTS.md", Text: string([]byte{255})}} {
		if _, err := discoveryInstruction(instruction); err == nil {
			t.Fatalf("unclassified/invalid instruction admitted: %T", instruction)
		}
	}
	input, catalogue, selected, bootstrap := discoveryResults()
	result, err := catalogueResult(input, &catalogue)
	if err != nil || string(result.Workspaces) != "[]" {
		t.Fatal("empty catalogue became null")
	}
	projected, err := bootstrapResult(selected, &bootstrap)
	if err != nil || string(projected.Instructions) != "[]" || string(projected.Complete) != "true" {
		t.Fatal("empty collection or boolean lost")
	}
	catalogue.Workspaces = make([]workspacect.CatalogueEntry, 33)
	bootstrap.Instructions = make([]workspacect.Instruction, 34)
	if _, err := catalogueResult(input, &catalogue); err == nil {
		t.Fatal("catalogue owner bound widened")
	}
	if _, err := bootstrapResult(selected, &bootstrap); err == nil {
		t.Fatal("instruction owner bound widened")
	}
}

func TestDiscoveryCompleteReplyBoundBeforeFrame(t *testing.T) {
	input, output, _, _ := discoveryResults()
	path := "/" + strings.Repeat("<", 4095)
	for i := 0; i < 32; i++ {
		output.Workspaces = append(output.Workspaces, workspacect.CatalogueEntry{WorkspaceID: fmt.Sprintf("work%d", i), Root: path, ApprovedRoot: workspacect.Root{Path: path, Device: "1", Inode: "2"}})
	}
	result, err := catalogueResult(input, &output)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := discoveryBodies()
	request := Request{RequestID: "r", Body: discoveryJSON(t, body)}
	out, err := discoveryResult("ComputerCatalogueResponse", result, request, discoveryPeer, func(code, source string) *Outcome { return catalogueRefusal(&body, code, source) })
	if err != nil || out.Status != "refused" || out.Code != "output_bound" || bytes.Contains(out.Data, []byte(`\u003c`)) {
		t.Fatal("escaped output escaped the typed bound")
	}
	// A payload that fits by itself can still overflow after exact envelope IDs
	// and context are encoded. Set size from the real encoding, not an estimate.
	// Fill canonical entries with ASCII first, then account for the exact five
	// extra encoded bytes per '<'. Both paths stay within the owner's bounds.
	for i := range output.Workspaces {
		output.Workspaces[i].Root = "/" + strings.Repeat("x", 4095)
		output.Workspaces[i].ApprovedRoot.Path = output.Workspaces[i].Root
	}
	result, err = catalogueResult(input, &output)
	if err != nil {
		t.Fatal(err)
	}
	data := discoveryJSON(t, result)
	base := discoveryJSON(t, wire.Response{Jsonrpc: "2.0", Id: &request.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: request.RequestID, Context: discoveryPeer, Data: data}})
	escapes := (ipc.MaxFrameBytes-len(base))/5 + 1
	for i := range output.Workspaces {
		for _, path := range []*string{&output.Workspaces[i].Root, &output.Workspaces[i].ApprovedRoot.Path} {
			count := min(escapes, 4095)
			*path = "/" + strings.Repeat("<", count) + strings.Repeat("x", 4095-count)
			escapes -= count
		}
	}
	if escapes != 0 {
		t.Fatal("fixture capacity insufficient")
	}
	result, err = catalogueResult(input, &output)
	if err != nil {
		t.Fatal(err)
	}
	data = discoveryJSON(t, result)
	if len(data) >= ipc.MaxFrameBytes {
		t.Fatal("fixture does not isolate envelope overhead")
	}
	out, err = discoveryResult("ComputerCatalogueResponse", result, request, discoveryPeer, func(code, source string) *Outcome { return catalogueRefusal(&body, code, source) })
	if err != nil || out.Code != "output_bound" {
		t.Fatal("only payload size was bounded")
	}
	encoded, err := responseJSON(wire.Response{Jsonrpc: "2.0", Id: &request.RequestID, Result: &wire.Outcome{Status: out.Status, RequestId: request.RequestID, Context: discoveryPeer, Code: optional(out.Code), Data: out.Data}})
	if err != nil || len(encoded) > ipc.MaxFrameBytes {
		t.Fatal("bounded refusal is not frameable")
	}
	var frame bytes.Buffer
	if ipc.WriteFrame(&frame, encoded) != nil {
		t.Fatal("refusal frame failed")
	}
	if got, err := ipc.ReadFrame(&frame); err != nil || !bytes.Equal(got, encoded) {
		t.Fatal("refusal frame changed")
	}
}

func TestDiscoveryExplicitRegistrationAndUnknownCorrelation(t *testing.T) {
	catalogue, bootstrap := discoveryBodies()
	for i, name := range []string{"computer.workspace.catalogue", "computer.workspace.bootstrap"} {
		if !wire.KnownMethod(name) || wire.RequiresOperationID(name) {
			t.Fatal("discovery method is not a canonical read")
		}
		server, err := New(Config{BuildID: "build", ProfileID: discoveryPeer.ProfileId, Generation: discoveryPeer.BackendGeneration})
		if err != nil {
			t.Fatal(err)
		}
		hello := wire.Request{Jsonrpc: "2.0", Id: "h", Method: "core.handshake", Params: wire.Call{Body: json.RawMessage(`{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`)}}
		response := server.dispatch(context.Background(), discoveryJSON(t, hello))
		if bytes.Contains(response.Result.Data, []byte(name)) {
			t.Fatal("schema metadata made method live")
		}
		body := []any{catalogue, bootstrap}[i]
		request := wire.Request{Jsonrpc: "2.0", Id: "r", Method: name, Params: wire.Call{Context: &discoveryPeer, Body: discoveryJSON(t, body)}}
		response = server.dispatch(context.Background(), discoveryJSON(t, request))
		if response.Result.Status != "unavailable" {
			t.Fatal("unregistered method was dispatched")
		}
		calls := 0
		method := discoveryMethods(func(context.Context) (*workspacect.Contract, error) {
			calls++
			return nil, errors.New("private unknown factory error")
		})[i]
		server, err = New(Config{BuildID: "build", ProfileID: discoveryPeer.ProfileId, Generation: discoveryPeer.BackendGeneration, Methods: map[string]Method{name: method}})
		if err != nil {
			t.Fatal(err)
		}
		server.dispatch(context.Background(), discoveryJSON(t, hello))
		response = server.dispatch(context.Background(), discoveryJSON(t, request))
		if response.Result.Status != "unknown" || response.Result.RequestId != "r" || *response.Id != "r" || response.Result.Context != discoveryPeer || response.Result.OperationId != nil || len(response.Result.Data) != 0 || calls != 1 {
			t.Fatal("unknown outcome/correlation lost or replayed")
		}
		request.Id = "effect"
		request.Params.OperationId = optional("operation")
		if server.dispatch(context.Background(), discoveryJSON(t, request)).Error == nil || calls != 1 {
			t.Fatal("read admitted an operation ID")
		}
		request.Id = "stale"
		request.Params.OperationId = nil
		stale := discoveryPeer
		stale.BackendGeneration = "other"
		request.Params.Context = &stale
		if server.dispatch(context.Background(), discoveryJSON(t, request)).Error == nil || calls != 1 {
			t.Fatal("stale context reached factory")
		}
	}
}

func TestDiscoveryDoesNotCreateAnExecutionLease(t *testing.T) {
	catalogue, bootstrap := discoveryBodies()
	// This trusted consumer deliberately supplies a service without an execution
	// lease. The adapter cannot turn valid wire correlation into positive admission.
	contract := workspacect.New(workspacesvc.New(nil, nil, nil))
	for i, body := range []any{catalogue, bootstrap} {
		calls := 0
		method := discoveryMethods(func(context.Context) (*workspacect.Contract, error) { calls++; return contract, nil })[i]
		out, err := method.Handle(context.Background(), Request{RequestID: "r", Body: discoveryJSON(t, body)})
		if err != nil || out.Status != "refused" || out.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || calls != 1 {
			t.Fatal("wire manufactured an execution lease")
		}
		var refused struct{ Source, Retry string }
		if json.Unmarshal(out.Data, &refused) != nil || refused.Source != "authority-store" || refused.Retry != "never" {
			t.Fatal("lease prerequisite refusal lost")
		}
	}
}

func TestDiscoveryBootstrapEscapingBoundAndFactoryFailureDoNotDisclose(t *testing.T) {
	_, _, selected, output := discoveryResults()
	path := strings.Repeat("<", 4096)
	// Each field fits the canonical per-field bound; JSON control/HTML escaping
	// of the complete collection exceeds the shared frame ceiling.
	output.Instructions = append(output.Instructions, workspacect.ReadInstruction{RelativePath: path, Text: strings.Repeat("\x01", 65536), Bytes: 65536})
	for i := 1; i < 33; i++ {
		output.Instructions = append(output.Instructions, workspacect.MissingInstruction{RelativePath: path})
	}
	projected, err := bootstrapResult(selected, &output)
	if err != nil {
		t.Fatal(err)
	}
	_, body := discoveryBodies()
	out, err := discoveryResult("ComputerBootstrapResponse", projected, Request{RequestID: "r"}, discoveryPeer, func(code, source string) *Outcome { return bootstrapRefusal(&body, code, source) })
	if err != nil || out.Status != "refused" || out.Code != "output_bound" || bytes.Contains(out.Data, []byte(`\u0001`)) || bytes.Contains(out.Data, []byte(`\u003c`)) {
		t.Fatal("bootstrap escaped output was disclosed")
	}
	contract, native := discoveryContract(t)
	sentinel := errors.New("selection outcome unknown despite nonnil result")
	calls := 0
	method := BootstrapMethod(func(context.Context, workspacect.BootstrapRequest) (*workspacect.Contract, error) {
		calls++
		return contract, sentinel
	}, discoveryPeer)
	out, err = method.Handle(context.Background(), Request{RequestID: "r", Body: discoveryJSON(t, body)})
	if out != nil || err != sentinel || calls != 1 || native.reads != 0 || native.lists != 0 {
		t.Fatal("factory failure invoked or replayed Computer")
	}
	ctx, cancel := context.WithCancel(context.Background())
	method = BootstrapMethod(func(context.Context, workspacect.BootstrapRequest) (*workspacect.Contract, error) {
		calls++
		cancel()
		return contract, nil
	}, discoveryPeer)
	out, err = method.Handle(ctx, Request{RequestID: "r", Body: discoveryJSON(t, body)})
	if err != nil || out.Code != "WORKSPACE_REQUEST_CANCELLED" || calls != 2 || native.reads != 0 || native.lists != 0 {
		t.Fatal("cancelled selection invoked Computer")
	}
}

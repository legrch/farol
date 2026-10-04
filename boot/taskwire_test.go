package boot

// CPU aggregate through the actual common framed Server and selected Task
// facade. Only native provider/storage/authority boundaries are scripted.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type taskWireTestFrame struct {
	Method   string          `json:"method"`
	Response json.RawMessage `json:"response"`
}

type taskWireTestPeer struct {
	frames   []taskWireTestFrame
	t        *testing.T
	in       *io.PipeWriter
	out      *io.PipeReader
	sequence int
	scope    wire.Context
}

func taskWireTestConnect(t *testing.T, ingress *TaskIngress) *taskWireTestPeer {
	t.Helper()
	return taskWireTestConnectMethods(t, ingress.Methods(), wire.Context{ProfileId: "fixture-profile", BackendGeneration: "backend"})
}

func taskWireTestConnectMethods(t *testing.T, methods map[string]desktop.Method, peer wire.Context) *taskWireTestPeer {
	t.Helper()
	server, err := desktop.New(desktop.Config{BuildID: "task-fixture", ProfileID: peer.ProfileId, Generation: peer.BackendGeneration, Methods: methods})
	if err != nil {
		t.Fatal(err)
	}
	input, send := io.Pipe()
	receive, output := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, input, output) }()
	t.Cleanup(func() {
		cancel()
		send.Close()
		receive.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("CPU framed server did not close")
		}
	})
	p := &taskWireTestPeer{t: t, in: send, out: receive, scope: peer}
	response := p.call("core.handshake", "", fmt.Sprintf(`{"protocolMajor":1,"protocolMinor":0,"buildId":"task-fixture","profileId":%q}`, peer.ProfileId))
	if response.Result == nil || response.Result.Status != "ok" {
		t.Fatal("handshake", response)
	}
	return p
}
func (p *taskWireTestPeer) call(method, operation, body string) wire.Response {
	p.t.Helper()
	p.sequence++
	var scope *wire.Context
	if method != "core.handshake" {
		copy := p.scope
		scope = &copy
	}
	request := wire.Request{Jsonrpc: "2.0", Id: fmt.Sprintf("request-%d", p.sequence), Method: method, Params: wire.Call{Context: scope, OperationId: taskWireOptional(operation), Body: json.RawMessage(body)}}
	raw, err := json.Marshal(request)
	if err != nil {
		p.t.Fatal(err)
	}
	if err = ipc.WriteFrame(p.in, raw); err != nil {
		p.t.Fatal("write", err)
	}
	raw, err = ipc.ReadFrame(p.out)
	if err != nil {
		p.t.Fatal("read", err)
	}
	if ipc.ValidateJSON(raw) != nil || wire.Validate("Response", raw) != nil {
		p.t.Fatal("invalid response", string(raw))
	}
	var response wire.Response
	if err = json.Unmarshal(raw, &response); err != nil {
		p.t.Fatal(err)
	}
	p.frames = append(p.frames, taskWireTestFrame{Method: method, Response: append(json.RawMessage(nil), raw...)})
	return response
}
func taskWireTestData[T any](t *testing.T, response wire.Response, shape string) T {
	t.Helper()
	var out T
	if response.Result == nil || response.Result.Status != "ok" || wire.Validate(shape, response.Result.Data) != nil {
		t.Fatalf("%s response=%+v fault=%+v", shape, response.Result, response.Error)
	}
	if err := json.Unmarshal(response.Result.Data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestTaskWireConcreteJourneyAndRetainedFollowup(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	p := taskWireTestConnect(t, f.ingress)
	resolved := taskWireTestData[wire.TaskResolution](t, p.call("task.resolve", "", "{}"), "TaskResolution")
	if !resolved.Capabilities.Create || !resolved.Capabilities.Continue || resolved.Capabilities.Cancel || resolved.Binding.Model != "fixture-model" {
		t.Fatal(resolved)
	}
	created := taskWireTestData[wire.TaskMutation](t, p.call("task.create", "create-1", `{"message":"framed source task"}`), "TaskMutation")
	if created.OperationId != "create-1" || created.Receipt.Reference.ThreadId == nil || created.Receipt.Reference.TurnId == nil {
		t.Fatal(created)
	}
	reads := f.pipe.count("thread/read")
	running := taskWireTestData[wire.TaskDispatch](t, p.call("task.status", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if running.Lifecycle != "running" || running.Retained || f.pipe.count("thread/read") != reads {
		t.Fatal(running)
	}
	f.pipe.complete("turn-1")
	observed := taskWireTestData[wire.TaskStatus](t, p.call("task.observe", "", "{}"), "TaskStatus")
	if observed.Lifecycle != "completed" || observed.DispatchId == nil || *observed.DispatchId != "create-1" {
		t.Fatal(observed)
	}
	first := taskWireTestData[wire.TaskDispatch](t, p.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !first.Retained || first.Text != "retained turn-1" || first.ResultEvidence != "task_journal" || first.Delivery != "not_observed" {
		t.Fatal(first)
	}
	metadata := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", `{"dispatchId":"create-1","limit":1,"includeResult":false}`), "TaskObservation")
	if metadata.Result != "" || metadata.Next.Generation == "" || metadata.Next.Sequence == "" {
		t.Fatal(metadata)
	}
	f.selectTurn(t, 2) // Trusted Root chooses a fresh facade; a body cannot do this.
	next := taskWireTestConnect(t, f.ingress)
	stale := p.call("task.continue", "stale-2", `{"dispatchId":"create-1","message":"old caller"}`)
	if stale.Result == nil || stale.Result.Status == "ok" || f.pipe.count("turn/start") != 1 {
		t.Fatal("stale selected facade dispatched", stale)
	}
	follow := taskWireTestData[wire.TaskMutation](t, next.call("task.continue", "follow-2", `{"dispatchId":"create-1","message":"same thread follow-up"}`), "TaskMutation")
	if !reflect.DeepEqual(follow.Receipt.Reference.ThreadId, created.Receipt.Reference.ThreadId) || follow.Receipt.Reference.TurnId == nil || *follow.Receipt.Reference.TurnId != "turn-2" {
		t.Fatal(follow)
	}
	reads = f.pipe.count("thread/read")
	historical := taskWireTestData[wire.TaskDispatch](t, next.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !reflect.DeepEqual(first, historical) || f.pipe.count("thread/read") != reads {
		t.Fatal("historical result substituted/polled", historical)
	}
	f.pipe.complete("turn-2")
	taskWireTestData[wire.TaskStatus](t, next.call("task.observe", "", "{}"), "TaskStatus")
	second := taskWireTestData[wire.TaskDispatch](t, next.call("task.result", "", `{"dispatchId":"follow-2"}`), "TaskDispatch")
	if second.Text != "retained turn-2" || second.Reference.TurnId == nil || *second.Reference.TurnId != "turn-2" || f.pipe.count("thread/start") != 1 || f.pipe.count("turn/start") != 2 || f.pipe.launches.Load() != 1 {
		t.Fatal(second)
	}
	// Verbose CPU evidence can be checked with the generated TypeScript validator.
	frames, err := json.Marshal(append(p.frames, next.frames...))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("TASK_WIRE_CONTROLLED_FRAMES %s", frames)
}
func TestTaskWireLostACKNeverBecomesSecondSend(t *testing.T) {
	f := taskIngressTestSetup(t, true)
	p := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskResolution](t, p.call("task.resolve", "", "{}"), "TaskResolution")
	unknown := p.call("task.create", "lost-create", `{"message":"one controlled effect"}`)
	if unknown.Result == nil || unknown.Result.Status != "unknown" || wire.Validate("TaskMutation", unknown.Result.Data) != nil {
		t.Fatalf("possible effect certainty lost: %+v", unknown)
	}
	before := f.pipe.count("turn/start")
	retained := taskWireTestData[wire.TaskOperation](t, p.call("task.operation.status", "", `{"operationId":"lost-create"}`), "TaskOperation")
	if retained.OperationId != "lost-create" || retained.Receipt.State != "outcome_unknown" {
		t.Fatal(retained)
	}
	for _, id := range []string{"lost-create", "changed-operation"} {
		result := p.call("task.create", id, `{"message":"one controlled effect"}`)
		if result.Result == nil || result.Result.Status == "ok" {
			t.Fatal("unknown mutation redispatched", result)
		}
	}
	if before != 1 || f.pipe.count("turn/start") != before || f.pipe.count("thread/start") != 1 || f.pipe.launches.Load() != 1 {
		t.Fatal("extra effect or connection")
	}
}
func TestTaskWireRejectsCrossedContextAndBodyAuthorityBeforeProvider(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	p := taskWireTestConnect(t, f.ingress)
	for _, body := range []string{`{"message":"x","ownerId":"other"}`, `{"message":"x","model":"other"}`, `{"message":"x","taskEpoch":"99"}`, `{"message":"x","grant":{}}`, `{"message":"x","message":"y"}`} {
		r := p.call("task.create", "reject", body)
		if r.Error == nil && (r.Result == nil || r.Result.Status != "refused") {
			t.Fatal("invalid body accepted", body, r)
		}
	}
	if r := p.call("task.create", "", `{"message":"x"}`); r.Error == nil {
		t.Fatal("missing effect operation accepted")
	}
	p.scope.BackendGeneration = "other-backend"
	if r := p.call("task.create", "crossed", `{"message":"x"}`); r.Error == nil {
		t.Fatal("crossed backend accepted")
	}
	if f.pipe.launches.Load() != 0 || f.pipe.count("turn/start") != 0 {
		t.Fatal("rejected request reached provider")
	}
}
func TestTaskWireReadDoesNotLeakResultOrWidenPage(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	p := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskMutation](t, p.call("task.create", "create", `{"message":"read surface"}`), "TaskMutation")
	f.pipe.complete("turn-1")
	taskWireTestData[wire.TaskStatus](t, p.call("task.observe", "", "{}"), "TaskStatus")
	status := taskWireTestData[wire.TaskDispatch](t, p.call("task.status", "", `{"dispatchId":"create"}`), "TaskDispatch")
	if status.Text != "" || !status.Retained {
		t.Fatal(status)
	}
	reads := f.pipe.count("thread/read")
	for _, body := range []string{`{"dispatchId":"create","limit":33}`, `{"dispatchId":"create","cursor":{"streamId":"","generation":1,"sequence":"0"}}`, `{"dispatchId":"create","cursor":{"streamId":"","generation":"18446744073709551616","sequence":"0"}}`} {
		r := p.call("task.observation.read", "", body)
		if r.Result == nil || r.Result.Status != "refused" {
			t.Fatal(body, r)
		}
	}
	if f.pipe.count("thread/read") != reads {
		t.Fatal("retained metadata queried provider")
	}
}
func TestTaskWireFailureKeepsUncertaintyAndSanitizes(t *testing.T) {
	for _, tc := range []struct{ code, status string }{{"TASK_REQUEST_CANCELLED", "unknown"}, {"TASK_OUTCOME_UNKNOWN", "unknown"}, {"TASK_UNAVAILABLE", "unavailable"}, {"TASK_STATE_REFUSED", "refused"}, {"private\ntext", "unknown"}} {
		got, err := taskWireFailure(&TaskIngressFailure{tc.code})
		if err != nil || got.Status != tc.status {
			t.Fatal(got, err)
		}
		if tc.code == "private\ntext" && got.Code != "TASK_OUTCOME_UNKNOWN" {
			t.Fatal("raw diagnostic escaped")
		}
	}
	if _, err := taskWireFailure(errors.New("private diagnostic")); err == nil {
		t.Fatal("unclassified failure invented a receipt")
	}
	if ((*TaskIngress)(nil)).Methods() != nil {
		t.Fatal("nil Task advertised capabilities")
	}
}

func TestTaskWireUnselectedRouteDoesNotAdvertiseCapability(t *testing.T) {
	p := taskWireTestConnect(t, nil)
	r := p.call("task.create", "absent", `{"message":"no selected owner"}`)
	if r.Result == nil || r.Result.Status != "unavailable" || r.Result.Code == nil || *r.Result.Code != "capability_unavailable" {
		t.Fatal(r)
	}
}

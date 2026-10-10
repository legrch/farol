package boot

// Actual published selection, TaskSurface, framed transport and retained owner.
// CPU journals and Codex net.Pipe remain explicit controlled boundaries.
import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

func taskMessageWireBody(t *testing.T, handle *wire.TaskHandle, dispatch, message string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"handleId": handle.HandleId, "deadlineMillis": strconv.FormatInt(time.Now().Add(29*time.Second).UnixMilli(), 10), "request": map[string]any{"dispatchId": dispatch, "message": message}})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestTaskMessagePublicationTransportPreservesOriginalDispatchAndNonterminalACK(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	h, err := p.selector.BeginPublishedCodex(context.Background(), p.input)
	if err != nil {
		t.Fatal(err)
	}
	peer := taskWireTestConnectMethods(t, p.selector.surface.Methods(), p.f.profile.peer)
	created := taskWireTestData[wire.TaskMutation](t, peer.call("task.create", "create", taskSurfaceBody(t, h, wire.TaskCreate{Message: "original"})), "TaskMutation")
	ack := taskWireTestData[wire.TaskMutation](t, peer.call("task.message", "steer", taskMessageWireBody(t, h, "create", "adjust the running task")), "TaskMutation")
	if ack.OperationId != "steer" || ack.TaskId != created.TaskId || ack.Receipt.State != "known" || ack.Receipt.Lifecycle == nil || *ack.Receipt.Lifecycle != "running" || ack.Receipt.Result != "" || !reflect.DeepEqual(ack.Receipt.Reference, created.Receipt.Reference) {
		t.Fatal("framed steer invented a new target or completion", ack)
	}
	snapshot, err := p.f.task.store.Read(context.Background(), created.TaskId)
	if err != nil || snapshot.Task.DispatchID != "create" || snapshot.Pending != "" || len(p.f.profile.clients) != 1 || p.f.task.pipe.count("turn/start") != 1 || p.f.task.pipe.count("turn/steer") != 1 || p.f.task.pipe.launches.Load() != 1 {
		t.Fatal("framed Message replaced original owner/dispatch", snapshot, err)
	}
	p.f.task.pipe.complete(*created.Receipt.Reference.TurnId)
	_ = taskWireTestData[wire.TaskStatus](t, peer.call("task.observe", "", taskSurfaceBody(t, h, nil)), "TaskStatus")
	result := taskWireTestData[wire.TaskDispatch](t, peer.call("task.result", "", taskSurfaceBody(t, h, wire.TaskDispatchRequest{DispatchId: "create"})), "TaskDispatch")
	if result.Text != "retained turn-1" || !result.Retained {
		t.Fatal("original result observation lost after steer", result)
	}
}

func TestTaskMessageLostACKReconnectOnlyReadsOriginalUncertainOperation(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	h, err := p.selector.BeginPublishedCodex(context.Background(), p.input)
	if err != nil {
		t.Fatal(err)
	}
	methods := p.selector.surface.Methods()
	peer := taskWireTestConnectMethods(t, methods, p.f.profile.peer)
	_ = taskWireTestData[wire.TaskMutation](t, peer.call("task.create", "create", taskSurfaceBody(t, h, wire.TaskCreate{Message: "original"})), "TaskMutation")
	p.f.task.pipe.mu.Lock()
	p.f.task.pipe.dropSteer = true
	p.f.task.pipe.mu.Unlock()
	unknown := peer.call("task.message", "lost-steer", taskMessageWireBody(t, h, "create", "one uncertain steer"))
	if unknown.Result == nil || unknown.Result.Status != "unknown" {
		t.Fatal("lost ACK did not retain UNKNOWN", unknown)
	}
	reconnected := taskWireTestConnectMethods(t, methods, p.f.profile.peer)
	retained := taskWireTestData[wire.TaskOperation](t, reconnected.call("task.operation.status", "", taskSurfaceBody(t, h, wire.TaskOperationRequest{OperationId: "lost-steer"})), "TaskOperation")
	if retained.Action != "message" || retained.Receipt.State != "outcome_unknown" {
		t.Fatal("reconnect did not read original uncertain Message", retained)
	}
	_ = reconnected.call("task.message", "new-key", taskMessageWireBody(t, h, "create", "never retry UNKNOWN"))
	if p.f.task.pipe.count("turn/steer") != 1 || p.f.task.pipe.count("turn/start") != 1 || p.f.task.pipe.launches.Load() != 1 {
		t.Fatal("transport reconnect replayed or restarted the provider")
	}
}

func TestTaskMessageWireCannotSelectProviderTargetOrRenewAuthority(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	peer := taskWireTestConnectMethods(t, s.Methods(), f.profile.peer)
	_ = taskWireTestData[wire.TaskMutation](t, peer.call("task.create", "create", taskSurfaceBody(t, h, wire.TaskCreate{Message: "original"})), "TaskMutation")
	before := f.task.pipe.methods()
	for _, field := range []string{"threadId", "expectedTurnId", "taskId", "model", "cwd", "sandboxPolicy", "taskEpoch"} {
		body := map[string]any{"handleId": h.HandleId, "deadlineMillis": strconv.FormatInt(time.Now().Add(29*time.Second).UnixMilli(), 10), "request": map[string]any{"dispatchId": "create", "message": "adjust", field: "caller-selected"}}
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		out := peer.call("task.message", "injected-"+field, string(raw))
		if out.Result == nil || out.Result.Status != "refused" {
			t.Fatal("wire body selected authority", field, out)
		}
	}
	for _, body := range []string{taskMessageWireBody(t, h, "foreign", "wrong dispatch"), taskMessageWireBody(t, h, "create", strings.Repeat("a", 8193))} {
		out := peer.call("task.message", "stale-or-unbounded", body)
		if out.Result == nil || out.Result.Status != "refused" {
			t.Fatal("stale or unbounded Message admitted", out)
		}
	}
	if !reflect.DeepEqual(before, f.task.pipe.methods()) || f.task.pipe.count("turn/steer") != 0 {
		t.Fatal("invalid wire request reached provider")
	}
	oldBackend := taskWireTestConnect(t, nil)
	out := oldBackend.call("task.message", "unselected", `{"dispatchId":"create","message":"no selected route"}`)
	if out.Result == nil || out.Result.Status != "unavailable" {
		t.Fatal("known wire method manufactured an unselected capability", out)
	}
}

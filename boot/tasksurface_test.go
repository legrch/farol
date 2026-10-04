package boot

// Common framed desktop transport, actual Chat parent and retained Go Task
// profile/facades. Storage, host authority and Codex net.Pipe remain CPU doubles;
// these tests do not qualify native startup, an account or a live provider.
import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

func taskSurfaceBody(t *testing.T, h *wire.TaskHandle, request any) string {
	t.Helper()
	body := map[string]any{"handleId": h.HandleId}
	if request != nil {
		body["request"] = request
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestTaskSurfaceCommonConnectionRetainsExactTurnFacades(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	taskProgressEnable(f.task)
	ctx := context.Background()
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(ctx, f.input)
	if err != nil || h == nil || len(s.handles) != 1 || f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("selection was not lazy", h, err)
	}
	p := taskWireTestConnectMethods(t, s.Methods(), f.profile.peer)
	resolution := taskWireTestData[wire.TaskResolution](t, p.call("task.resolve", "", taskSurfaceBody(t, h, nil)), "TaskResolution")
	if !resolution.Capabilities.Create || !resolution.Capabilities.Continue || resolution.Capabilities.Resume || resolution.Capabilities.Cancel {
		t.Fatal("routed capability invented", resolution)
	}
	created := taskWireTestData[wire.TaskMutation](t, p.call("task.create", "create", taskSurfaceBody(t, h, wire.TaskCreate{Message: "first routed task"})), "TaskMutation")
	if created.OperationId != "create" || created.Receipt.Reference.ThreadId == nil || created.Receipt.Reference.TurnId == nil {
		t.Fatal(created)
	}

	includeResult := true
	progress := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", taskSurfaceBody(t, h, wire.TaskObservationRequest{DispatchId: "create", IncludeResult: &includeResult})), "TaskObservation")
	if progress.Lifecycle != "running" || progress.Retained || progress.Result != "" || len(progress.Events) != 5 || f.task.pipe.count("thread/read") != 0 {
		t.Fatal("routed progress was lost or promoted to terminal result", progress)
	}
	f.task.pipe.complete(*created.Receipt.Reference.TurnId)
	_ = taskWireTestData[wire.TaskStatus](t, p.call("task.observe", "", taskSurfaceBody(t, h, nil)), "TaskStatus")
	in := f.input
	in.Scope.TaskEpoch = 2
	in.Scope.TurnID = "follow-up"
	h2, err := s.SelectCodex(ctx, in)
	if err != nil || h2 == nil || h2.HandleId == h.HandleId || len(f.profile.tasks) != 1 || len(f.profile.clients) != 1 {
		t.Fatal("new turn replaced original owner/client", h2, err)
	}
	continued := taskWireTestData[wire.TaskMutation](t, p.call("task.continue", "follow", taskSurfaceBody(t, h2, wire.TaskContinue{DispatchId: "create", Message: "same exact task"})), "TaskMutation")
	if continued.Receipt.Reference.ThreadId == nil || *continued.Receipt.Reference.ThreadId != *created.Receipt.Reference.ThreadId || continued.Receipt.Reference.TurnId == nil || *continued.Receipt.Reference.TurnId != "turn-2" {
		t.Fatal("routed follow-up changed lineage", continued)
	}
	continuedProgress := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", taskSurfaceBody(t, h2, wire.TaskObservationRequest{DispatchId: "follow"})), "TaskObservation")
	if len(continuedProgress.Events) != 5 || continuedProgress.Next.StreamId == progress.Next.StreamId {
		t.Fatal("next facade reused or lost original event stream", continuedProgress)
	}
	result := taskWireTestData[wire.TaskDispatch](t, p.call("task.result", "", taskSurfaceBody(t, h2, wire.TaskDispatchRequest{DispatchId: "create"})), "TaskDispatch")
	if result.Text != "retained turn-1" {
		t.Fatal("old dispatch result lost", result)
	}
	stale := p.call("task.create", "stale", taskSurfaceBody(t, h, wire.TaskCreate{Message: "old facade cannot impersonate next turn"}))
	if stale.Result == nil || stale.Result.Status == "ok" {
		t.Fatal("old handle was reselected", stale)
	}
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 2 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("routing created another provider lifetime/effect")
	}
	if err = f.profile.Close(ctx); err != nil {
		t.Fatal(err)
	}
	closed := p.call("task.resolve", "", taskSurfaceBody(t, h2, nil))
	if closed.Result == nil || closed.Result.Status != "unavailable" {
		t.Fatal("closed profile exposed facade", closed)
	}
}

func TestTaskSurfaceBodiesCannotSelectAuthorityOrAnotherLifetime(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	p := taskWireTestConnectMethods(t, s.Methods(), f.profile.peer)
	for i, body := range []string{
		`{"handleId":"missing","request":{"message":"must not dispatch"}}`,
		`{"handleId":"` + h.HandleId + `","request":{"message":"x","model":"other"}}`,
		`{"handleId":"` + h.HandleId + `","request":{"message":"x"},"taskEpoch":"99"}`,
		`{"handleId":"` + h.HandleId + `","request":{"message":"x"},"handleId":"other"}`,
		`{"message":"single-facade body must not reach routed surface"}`,
	} {
		r := p.call("task.create", string(rune('a'+i)), body)
		if r.Result != nil && r.Result.Status == "ok" {
			t.Fatal("unselected authority accepted", body, r)
		}
	}
	p.scope.BackendGeneration = "other-backend"
	r := p.call("task.create", "crossed", taskSurfaceBody(t, h, wire.TaskCreate{Message: "wrong context"}))
	if r.Result != nil && r.Result.Status == "ok" {
		t.Fatal("crossed backend accepted", r)
	}
	if f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("invalid body reached provider or published admission")
	}
}

func TestTaskSurfaceLostACKReconnectReadsOriginalWithoutSend(t *testing.T) {
	f := taskProfileTestSetup(t, true)
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	p := taskWireTestConnectMethods(t, s.Methods(), f.profile.peer)
	_ = p.call("task.create", "lost", taskSurfaceBody(t, h, wire.TaskCreate{Message: "one original effect"}))
	reconnected := taskWireTestConnectMethods(t, s.Methods(), f.profile.peer)
	operation := taskWireTestData[wire.TaskOperation](t, reconnected.call("task.operation.status", "", taskSurfaceBody(t, h, wire.TaskOperationRequest{OperationId: "lost"})), "TaskOperation")
	if operation.OperationId != "lost" || operation.Receipt.State != "outcome_unknown" {
		t.Fatal("unknown operation reinterpreted", operation)
	}
	_ = reconnected.call("task.create", "changed-id", taskSurfaceBody(t, h, wire.TaskCreate{Message: "never replace unknown"}))
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("routed reconnect retried provider mutation")
	}
}

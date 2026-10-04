package boot

// Integration fixtures exercise real provider projection, Owner and Service.
// The existing memory backing models atomic publication only, not native storage.
import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/task/domain"
)

func (j *taskRuntimeTestMemory) RecordEvent(_ context.Context, event task.ExecutionEvent) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[event.DispatchID]
	if !ok {
		return task.ErrNotFound
	}
	ref := op.Lineage
	if op.Settled && op.Receipt.State == task.Known {
		ref = op.Receipt.Reference
	}
	if event.RunID != op.Intent.TaskID || event.Reference != ref || op.Settled && (op.Receipt.State != task.Known || op.Receipt.Lifecycle.Terminal()) {
		return task.ErrIdentity
	}
	next, err := op.Events.Append(event, op.Intent.Binding.Provider)
	if err != nil {
		return err
	}
	op.Events = next
	j.ops[event.DispatchID] = op
	if j.eventPublicationUnknown {
		return task.ErrUnknown
	}
	return nil
}

const taskProgressPrivate = "CONTROLLED_PRIVATE_TRANSCRIPT_SENTINEL"

func taskProgressNotice(method string, params map[string]any) []byte {
	raw, err := json.Marshal(map[string]any{"method": method, "params": params})
	if err != nil {
		panic(err)
	}
	return raw
}
func taskProgressScript(turn string) [][]byte {
	base := func() map[string]any { return map[string]any{"threadId": "thread-exact", "turnId": turn} }
	started := base()
	started["turn"] = map[string]any{"id": turn, "status": "inProgress"}
	tool := base()
	tool["item"] = map[string]any{"id": "tool-one", "type": "commandExecution", "command": taskProgressPrivate, "output": strings.Repeat(taskProgressPrivate, 2100)}
	plan := base()
	plan["plan"] = []any{map[string]any{"step": taskProgressPrivate, "status": "completed"}, map[string]any{"step": taskProgressPrivate, "status": "inProgress"}}
	claim := base()
	claim["item"] = map[string]any{"id": "claim-one", "type": "agentMessage", "text": taskProgressPrivate}
	terminal := base()
	terminal["turn"] = map[string]any{"id": turn, "status": "completed"}
	foreign := map[string]any{"threadId": "another-thread", "turn": map[string]any{"id": turn, "status": "completed"}}
	return [][]byte{taskProgressNotice("turn/completed", foreign), taskProgressNotice("turn/started", started), taskProgressNotice("item/started", tool), taskProgressNotice("turn/plan/updated", plan), taskProgressNotice("item/completed", claim), taskProgressNotice("turn/completed", terminal)}
}
func taskProgressEnable(f *taskIngressTestFixture) {
	f.pipe.mu.Lock()
	defer f.pipe.mu.Unlock()
	f.pipe.notifications = func(req taskIngressTestRPC) [][]byte {
		if req.Method != "turn/start" {
			return nil
		}
		return taskProgressScript(fmt.Sprintf("turn-%d", f.pipe.count("turn/start")))
	}
}
func TestTaskProgressBeforeTerminalThroughCommonWire(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	taskProgressEnable(f)
	p := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskMutation](t, p.call("task.create", "progress-1", `{"message":"controlled progress"}`), "TaskMutation")
	observed := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", `{"dispatchId":"progress-1","includeResult":true}`), "TaskObservation")
	if observed.Lifecycle != "running" || observed.Retained || observed.Pending || observed.Result != "" || len(observed.Events) != 5 || observed.Gap || observed.SourceGap {
		t.Fatalf("progress was lost or promoted to completion: %+v", observed)
	}
	kinds := []string{"provider_started", "tool_started", "checkpoint_ready", "model_claim", "provider_terminal"}
	for n, e := range observed.Events {
		if e.Kind != kinds[n] || e.Sequence != fmt.Sprint(n+1) || e.DispatchId != "progress-1" || e.Reference.TurnId == nil || *e.Reference.TurnId != "turn-1" {
			t.Fatal("uncorrelated metadata", e)
		}
	}
	checkpoint := observed.Events[2]
	if checkpoint.Source != "advisory_model" || checkpoint.PlanSteps != 2 || checkpoint.CompletedSteps != 1 || observed.Events[3].Source != "advisory_model" || observed.Events[4].ReportedLifecycle != "completed" {
		t.Fatal("evidence classification", observed.Events)
	}
	if f.pipe.count("thread/read") != 0 {
		t.Fatal("retained progress polled provider")
	}
	raw, _ := json.Marshal(observed)
	if strings.Contains(string(raw), taskProgressPrivate) {
		t.Fatal("private provider body escaped projection")
	}
	cursor, _ := json.Marshal(wire.TaskObservationRequest{DispatchId: "progress-1", Cursor: &observed.Next})
	replay := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", string(cursor)), "TaskObservation")
	if len(replay.Events) != 0 || replay.Retained || replay.Next != observed.Next {
		t.Fatal("cursor replay advanced or settled", replay)
	}
	f.pipe.complete("turn-1")
	taskWireTestData[wire.TaskStatus](t, p.call("task.observe", "", "{}"), "TaskStatus")
	final := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", `{"dispatchId":"progress-1","includeResult":true}`), "TaskObservation")
	if !final.Retained || final.Result != "retained turn-1" || final.Lifecycle != "completed" || final.Delivery != "not_observed" || !reflect.DeepEqual(final.Events, observed.Events) {
		t.Fatal("actual result or progress changed", final)
	}
	f.selectTurn(t, 2)
	next := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskMutation](t, next.call("task.continue", "progress-2", `{"dispatchId":"progress-1","message":"same task second turn"}`), "TaskMutation")
	second := taskWireTestData[wire.TaskObservation](t, next.call("task.observation.read", "", `{"dispatchId":"progress-2"}`), "TaskObservation")
	if len(second.Events) != 5 || second.Next.StreamId == observed.Next.StreamId || second.Reference.TurnId == nil || *second.Reference.TurnId != "turn-2" {
		t.Fatal("follow-up reused prior stream", second)
	}
	history := taskWireTestData[wire.TaskObservation](t, next.call("task.observation.read", "", `{"dispatchId":"progress-1","includeResult":true}`), "TaskObservation")
	if !reflect.DeepEqual(history, final) || f.pipe.count("thread/start") != 1 || f.pipe.count("turn/start") != 2 || f.pipe.launches.Load() != 1 {
		t.Fatal("history or exact session lost", history)
	}
	frames, _ := json.Marshal(append(p.frames, next.frames...))
	if strings.Contains(string(frames), taskProgressPrivate) {
		t.Fatal("private data reached common frame")
	}
	t.Logf("TASK_WIRE_CONTROLLED_FRAMES %s", frames)
}
func TestTaskProgressPublicationUnknownNeverRepeatsSend(t *testing.T) {
	f := taskIngressTestSetup(t, false)
	taskProgressEnable(f)
	f.store.eventPublicationUnknown = true
	p := taskWireTestConnect(t, f.ingress)
	result := p.call("task.create", "event-unknown", `{"message":"event publication fault"}`)
	if result.Result == nil || result.Result.Status != "unknown" {
		t.Fatal("publication uncertainty lost", result)
	}
	retained := taskWireTestData[wire.TaskOperation](t, p.call("task.operation.status", "", `{"operationId":"event-unknown"}`), "TaskOperation")
	if retained.Receipt.State != "outcome_unknown" {
		t.Fatal("metadata became terminal receipt", retained)
	}
	for _, id := range []string{"event-unknown", "another-after-unknown"} {
		r := p.call("task.create", id, `{"message":"event publication fault"}`)
		if r.Result == nil || r.Result.Status == "ok" {
			t.Fatal("uncertainty allowed dispatch", r)
		}
	}
	if f.pipe.count("turn/start") != 1 || f.pipe.count("thread/start") != 1 || f.pipe.launches.Load() != 1 {
		t.Fatal("publication failure caused another effect")
	}
}

package boot

// Same source-only aggregate as taskclaude_test.go. Fresh Root invocation and
// higher Task admission are explicit; provider session and retained history stay
// exact. The controlled child is not an installed CLI or native qualification.
import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

func taskClaudeCompletedFirst(t *testing.T) (*taskClaudeFixture, *taskWireTestPeer, wire.TaskDispatch) {
	t.Helper()
	f := taskClaudeSetup(t)
	p := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskMutation](t, p.call("task.create", "create-1", `{"message":"initial"}`), "TaskMutation")
	taskWireTestData[wire.TaskStatus](t, p.call("task.observe", "", "{}"), "TaskStatus")
	result := taskWireTestData[wire.TaskDispatch](t, p.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !result.Retained || result.Lifecycle != "completed" {
		t.Fatal("setup not settled", result)
	}
	return f, p, result
}
func TestTaskClaudeResumeCommonWireUsesExactSessionAndFreshInvocation(t *testing.T) {
	f, first, result := taskClaudeCompletedFirst(t)
	old := f.native
	f.clock.now = f.clock.now.Add(time.Hour)
	f.task.selectRoute(2)
	f.selectInvocation("resume-2", true)
	next := taskWireTestConnect(t, f.ingress)
	// Old facade cannot select a new operation, and no body can select latest.
	stale := first.call("task.resume", "resume-2", `{"dispatchId":"create-1","message":"followup"}`)
	if stale.Result == nil || stale.Result.Status == "ok" || f.native.starts != 0 {
		t.Fatal("stale route admitted", stale)
	}
	wrong := next.call("task.resume", "resume-2", `{"dispatchId":"not-current","message":"followup"}`)
	if wrong.Result == nil || wrong.Result.Status != "refused" || f.native.starts != 0 {
		t.Fatal("historical parent substituted", wrong)
	}
	started := taskWireTestData[wire.TaskMutation](t, next.call("task.resume", "resume-2", `{"dispatchId":"create-1","message":"followup"}`), "TaskMutation")
	if started.Receipt.Reference.SessionId == nil || *started.Receipt.Reference.SessionId != taskClaudeSession || started.Receipt.Reference.InvocationId == nil || *started.Receipt.Reference.InvocationId != "resume-2" {
		t.Fatal("resume selected a new session or old invocation", started)
	}
	progress := taskWireTestData[wire.TaskObservation](t, next.call("task.observation.read", "", `{"dispatchId":"resume-2","includeResult":true}`), "TaskObservation")
	if progress.Retained || progress.Lifecycle != "running" || len(progress.Events) != 1 || len(f.outputs) != 2 || f.native.reads != 1 {
		t.Fatal("missing useful progress before final", progress)
	}
	history := taskWireTestData[wire.TaskDispatch](t, next.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !reflect.DeepEqual(history, result) || old.reads != 2 || old.starts != 1 {
		t.Fatal("prior result changed or re-observed", history)
	}
	taskWireTestData[wire.TaskStatus](t, next.call("task.observe", "", "{}"), "TaskStatus")
	final := taskWireTestData[wire.TaskDispatch](t, next.call("task.result", "", `{"dispatchId":"resume-2"}`), "TaskDispatch")
	if !final.Retained || final.Text != "Retained resumed result" || final.Delivery != "not_observed" || f.native.starts != 1 || f.native.prepares != 1 || f.native.reservations != 1 || !f.native.deadline.After(old.deadline) {
		t.Fatal("resume did not settle exact invocation", final)
	}
	frames, _ := json.Marshal(append(first.frames, next.frames...))
	t.Logf("TASK_WIRE_CONTROLLED_FRAMES %s", frames)
}
func TestTaskClaudeResumeCommonWireLostStartACKNeverRetries(t *testing.T) {
	f, _, first := taskClaudeCompletedFirst(t)
	old := f.native
	f.task.selectRoute(2)
	f.selectInvocation("resume-2", true)
	f.native.unknownStart = true
	p := taskWireTestConnect(t, f.ingress)
	for _, id := range []string{"resume-2", "resume-2", "replacement-3"} {
		r := p.call("task.resume", id, `{"dispatchId":"create-1","message":"followup"}`)
		if r.Result == nil || r.Result.Status == "ok" {
			t.Fatal("unknown resumed again", r)
		}
	}
	if f.native.starts != 1 || f.native.prepares != 1 || f.native.reservations != 1 || f.native.reads != 0 || old.starts != 1 || old.reads != 2 {
		t.Fatal("lost ACK caused another process")
	}
	history := taskWireTestData[wire.TaskDispatch](t, p.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !reflect.DeepEqual(history, first) {
		t.Fatal("unknown resume destroyed prior result", history)
	}
}

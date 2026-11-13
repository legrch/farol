package boot

// CPU aggregate: real Task Owner/reservation contract, Root mapping, Computer
// process service and Claude adapter. Storage publication and native child are
// scripted ports. Native persistence, confinement and installed CLI remain unproved.
import (
	"context"
	"errors"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

type taskReservationTestMemory struct {
	*taskRuntimeTestMemory
	calls int
	mode  string
	last  task.NativeReservation
}

func (j *taskReservationTestMemory) ReserveNative(_ context.Context, in task.NativeReservation) (*port.ReservationReceipt, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.calls++
	j.last = in
	op, ok := j.ops[in.OperationID]
	if !ok || !in.Matches(op.Intent) || j.snapshot == nil || j.snapshot.Pending != in.OperationID {
		return nil, task.ErrIdentity
	}
	if op.Reservation != (task.NativeReservation{}) {
		return nil, errors.New("owner should retain prior reservation")
	}
	if j.mode == "before" {
		return nil, task.ErrUnknown
	}
	op.Reservation = in
	j.ops[in.OperationID] = op
	if j.mode == "after" {
		return nil, task.ErrUnknown
	}
	return &port.ReservationReceipt{Status: port.Reserved, Intent: in}, nil
}
func taskReservationDefault(t *testing.T, f *taskClaudeFixture) {
	t.Helper()
	f.inputs.Claude.Process.Reservations = nil
	var err error
	f.ingress, err = NewTaskIngress(f.inputs, controlct.Parent{ThreadID: "parent", TurnID: "parent-turn"})
	if err != nil {
		t.Fatal(err)
	}
}
func taskReservationSetup(t *testing.T) (*taskClaudeFixture, *taskReservationTestMemory) {
	t.Helper()
	f := taskClaudeSetup(t)
	j := &taskReservationTestMemory{taskRuntimeTestMemory: f.task.journal}
	var err error
	f.task.owner, err = taskrepo.New(j, "task")
	if err != nil {
		t.Fatal(err)
	}
	f.task.selectRoute(1)
	f.selectInvocation("create-1", false)
	taskReservationDefault(t, f)
	return f, j
}
func taskReservationOriginal(in task.NativeReservation) processsvc.Intent {
	b, s := in.Admission, in.Seal
	return processsvc.Intent{OperationID: in.OperationID,
		Binding:  computerport.TaskBinding{Identity: authority.Identity{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch}, ParticipantID: b.ParticipantID, TurnID: b.TurnID},
		Seal:     processsvc.Seal{Digest: s.Digest, WorkspaceID: s.WorkspaceID, Root: s.Root, Cwd: s.Cwd, RootIdentity: authority.RootIdentity{Device: s.RootIdentity.Device, Inode: s.RootIdentity.Inode}, Write: s.Write},
		Deadline: time.Unix(0, in.DeadlineUnixNano)}
}
func TestTaskReservationDefaultClaudeCreateAndExactResume(t *testing.T) {
	f, j := taskReservationSetup(t)
	first := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskMutation](t, first.call("task.create", "create-1", `{"message":"initial"}`), "TaskMutation")
	if j.calls != 1 || f.native.starts != 1 || f.native.reservations != 0 || !f.native.deadline.Equal(time.Unix(0, j.last.DeadlineUnixNano)) {
		t.Fatal("missing same-owner reservation", j.calls, f.native.starts)
	}
	original := j.last
	adapter, err := newTaskProcessReservation(f.task.route)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := adapter.Reserve(context.Background(), taskReservationOriginal(original))
	if err != nil || retained == nil || retained.Status != processsvc.Existing || j.calls != 1 {
		t.Fatal("repeat granted another publication", retained, err)
	}
	taskWireTestData[wire.TaskStatus](t, first.call("task.observe", "", "{}"), "TaskStatus")
	completed := taskWireTestData[wire.TaskDispatch](t, first.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !completed.Retained || completed.Text != "Retained Claude result" {
		t.Fatal(completed)
	}
	old := f.native
	f.clock.now = f.clock.now.Add(time.Hour)
	f.task.selectRoute(2)
	f.selectInvocation("resume-2", true)
	taskReservationDefault(t, f)
	next := taskWireTestConnect(t, f.ingress)
	mutation := taskWireTestData[wire.TaskMutation](t, next.call("task.resume", "resume-2", `{"dispatchId":"create-1","message":"followup"}`), "TaskMutation")
	if mutation.Receipt.Reference.SessionId == nil || *mutation.Receipt.Reference.SessionId != taskClaudeSession || mutation.Receipt.Reference.InvocationId == nil || *mutation.Receipt.Reference.InvocationId != "resume-2" {
		t.Fatal("provider identity changed", mutation)
	}
	if j.calls != 2 || j.last.OperationID != "resume-2" || j.last.Admission.TaskEpoch != 2 || j.last.DeadlineUnixNano <= original.DeadlineUnixNano || f.native.starts != 1 || f.native.reservations != 0 || old.starts != 1 {
		t.Fatal("resume reminted old reservation")
	}
	taskWireTestData[wire.TaskStatus](t, next.call("task.observe", "", "{}"), "TaskStatus")
	final := taskWireTestData[wire.TaskDispatch](t, next.call("task.result", "", `{"dispatchId":"resume-2"}`), "TaskDispatch")
	if !final.Retained || final.Text != "Retained resumed result" || len(f.outputs) != 2 {
		t.Fatal("resume did not preserve streamed and final results", final)
	}
}
func TestTaskReservationPublicationUnknownPreventsClaudeSpawn(t *testing.T) {
	for _, mode := range []string{"before", "after"} {
		t.Run(mode, func(t *testing.T) {
			f, j := taskReservationSetup(t)
			j.mode = mode
			p := taskWireTestConnect(t, f.ingress)
			for _, op := range []string{"create-1", "create-1", "replacement-2"} {
				out := p.call("task.create", op, `{"message":"initial"}`)
				if out.Result == nil || out.Result.Status == "ok" {
					t.Fatal("publication unknown was accepted", out)
				}
			}
			if j.calls != 1 || f.native.prepares != 1 || f.native.starts != 0 || f.native.reservations != 0 {
				t.Fatal("duplicate preparation/publication/spawn", j.calls, f.native)
			}
			// A fresh Root facade after a backend restart can only inspect retained proof.
			owner, err := taskrepo.New(j, "task")
			if err != nil {
				t.Fatal(err)
			}
			route, err := owner.Select(f.task.route.Selection())
			if err != nil {
				t.Fatal(err)
			}
			adapter, err := newTaskProcessReservation(route)
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := adapter.Reserve(context.Background(), taskReservationOriginal(j.last))
			if mode == "after" {
				if err != nil || receipt == nil || receipt.Status != processsvc.Existing {
					t.Fatal("lost ACK recovery", receipt, err)
				}
			} else if err == nil || receipt != nil {
				t.Fatal("absence authorized replay", receipt, err)
			}
			if j.calls != 1 || f.native.starts != 0 {
				t.Fatal("reload republished")
			}
		})
	}
}
func TestTaskReservationMappingRefusesChangedOrUnrepresentableIntent(t *testing.T) {
	f, j := taskReservationSetup(t)
	p := taskWireTestConnect(t, f.ingress)
	taskWireTestData[wire.TaskMutation](t, p.call("task.create", "create-1", `{"message":"initial"}`), "TaskMutation")
	adapter, err := newTaskProcessReservation(f.task.route)
	if err != nil {
		t.Fatal(err)
	}
	original := taskReservationOriginal(j.last)
	for name, mutate := range map[string]func(*processsvc.Intent){
		"zero":      func(i *processsvc.Intent) { i.Deadline = time.Time{} },
		"pre-epoch": func(i *processsvc.Intent) { i.Deadline = time.Unix(-1, 0) },
		"overflow":  func(i *processsvc.Intent) { i.Deadline = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC) },
		"deadline":  func(i *processsvc.Intent) { i.Deadline = i.Deadline.Add(time.Nanosecond) },
		"turn":      func(i *processsvc.Intent) { i.Binding.TurnID = "other" },
		"seal":      func(i *processsvc.Intent) { i.Seal.Write = !i.Seal.Write },
	} {
		t.Run(name, func(t *testing.T) {
			in := original
			mutate(&in)
			out, err := adapter.Reserve(context.Background(), in)
			if err == nil || out != nil {
				t.Fatal("changed intent accepted", out, err)
			}
		})
	}
	if j.calls != 1 || f.native.starts != 1 {
		t.Fatal("validation touched storage/effect")
	}
}

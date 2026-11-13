package boot

// Real selected Chat peer, Task owner/journal service and concrete Codex Client.
// Storage and the framed provider remain controlled; no native/live authority.
import (
	"context"
	"sync"
	"testing"

	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

func TestTaskProfileMessageACKKeepsOriginalRunningDispatchAndResultObserver(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	ctx := context.Background()
	created, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "original running task"})
	if err != nil || created.Receipt.State != controlct.Known {
		t.Fatal(created, err)
	}
	req := TaskIngressMessageRequest{DispatchID: "create", Message: "adjust the existing task"}
	ack, err := g.Message(ctx, "steer", req)
	if err != nil || ack.Receipt.State != controlct.Known || ack.Receipt.Reference != created.Receipt.Reference || ack.Receipt.Lifecycle != controlct.Running || ack.Receipt.Result != "" {
		t.Fatalf("exact active message did not receive a nonterminal ACK: %+v %v", ack, err)
	}
	if replay, err := g.Message(ctx, "steer", req); err != nil || *replay != *ack {
		t.Fatal("ACK replay changed", replay, err)
	}
	if f.task.pipe.count("turn/steer") != 1 || f.task.pipe.count("turn/start") != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("message started a new provider lifetime or repeated the effect")
	}
	snapshot, err := f.task.store.Read(ctx, "task")
	if err != nil || snapshot == nil || snapshot.Pending != "" || snapshot.Task.DispatchID != "create" || snapshot.Task.Lifecycle != task.Running || snapshot.Task.Result != "" {
		t.Fatal("message replaced dispatch or invented completion", snapshot, err)
	}
	f.task.pipe.complete("turn-1")
	observed, err := g.Observe(ctx)
	if err != nil || observed.DispatchID != "create" || observed.Lifecycle != controlct.Completed {
		t.Fatal("original observer lost after message", observed, err)
	}
	result, err := g.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create"})
	if err != nil || result.Text != "retained turn-1" || result.Reference != created.Receipt.Reference {
		t.Fatal("original result lost", result, err)
	}
}

func TestTaskProfileMessageExactRefusesStaleDispatchWithoutProviderReads(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	ctx := context.Background()
	if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "original"}); err != nil {
		t.Fatal(err)
	}
	before := f.task.pipe.methods()
	for _, dispatch := range []string{"", "foreign", "stale"} {
		_, err := g.Message(ctx, "stale-steer", TaskIngressMessageRequest{DispatchID: dispatch, Message: "adjust"})
		want := "TASK_IDENTITY_MISMATCH"
		if dispatch == "" {
			want = "TASK_INPUT_INVALID"
		}
		taskIngressTestFailure(t, err, want)
	}
	if len(f.task.pipe.methods()) != len(before) || f.task.pipe.count("turn/steer") != 0 {
		t.Fatal("stale dispatch contacted provider")
	}
}

func TestTaskProfileMessageDispatchGuardRechecksPendingActiveTarget(t *testing.T) {
	for _, changed := range []string{"pending", "reference", "lifecycle", "admission", "epoch", "cancel", "settled", "original-intent"} {
		t.Run(changed, func(t *testing.T) {
			f := taskProfileTestSetup(t, false)
			factory := f.profile.newClient
			f.profile.newClient = func(selection codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
				return factory(selection, q, grant, func(ctx context.Context, original task.Intent) error {
					if original.Action != task.Message {
						return dispatch(ctx, original)
					}
					f.task.store.mu.Lock()
					switch changed {
					case "pending":
						f.task.store.snapshot.Pending = "foreign-operation"
					case "reference":
						f.task.store.snapshot.Task.Reference.TurnID = "foreign-turn"
					case "lifecycle":
						f.task.store.snapshot.Task.Lifecycle = task.Completed
					case "admission":
						f.task.store.snapshot.Task.Admission.State = task.AdmissionRevoked
					case "epoch":
						f.task.store.snapshot.Task.Admission.Binding.TaskEpoch++
					case "cancel":
						f.task.store.snapshot.Task.CancelRequested = true
					case "settled":
						op := f.task.store.ops[original.OperationID]
						op.Settled = true
						f.task.store.ops[original.OperationID] = op
					case "original-intent":
						original.Expected.TurnID = "foreign-turn"
					}
					f.task.store.mu.Unlock()
					return dispatch(ctx, original)
				})
			}
			g := f.selectTurn(t, 1)
			ctx := context.Background()
			if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "original"}); err != nil {
				t.Fatal(err)
			}
			out, err := g.Message(ctx, "steer", TaskIngressMessageRequest{DispatchID: "create", Message: "must remain exact and active"})
			if err != nil || out.Receipt.State != controlct.Uncertain || f.task.pipe.count("turn/steer") != 0 {
				t.Fatal("changed active target reached write", out, err)
			}
			op, err := f.task.store.Lookup(ctx, "steer")
			if err != nil || op == nil || op.Intent.Expected.TurnID != "turn-1" || op.Intent.Admission.TaskEpoch != 1 || f.task.pipe.count("turn/start") != 1 {
				t.Fatal("original pending intent replaced", op, err)
			}
		})
	}
}

func TestTaskProfileMessageLostACKKeepsUnknownFenceWithoutReplayOrNewEpoch(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	ctx := context.Background()
	if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "original"}); err != nil {
		t.Fatal(err)
	}
	f.task.pipe.mu.Lock()
	f.task.pipe.dropSteer = true
	f.task.pipe.mu.Unlock()
	req := TaskIngressMessageRequest{DispatchID: "create", Message: "one uncertain message"}
	unknown, err := g.Message(ctx, "lost-steer", req)
	if err != nil || unknown.Receipt.State != controlct.Uncertain {
		t.Fatal(unknown, err)
	}
	if replay, err := g.runtime.Control().MessageExact(ctx, controlct.MessageExactRequest{OperationID: "lost-steer", TaskID: "task", Message: req.Message, ExpectedDispatchID: req.DispatchID}); err != nil || *replay != *unknown {
		t.Fatal("unknown replay changed", replay, err)
	}
	if _, err := g.Message(ctx, "lost-steer", req); err == nil {
		t.Fatal("fenced facade regained mutation admission")
	}
	retained, err := g.Operation(ctx, TaskIngressOperationRequest{OperationID: "lost-steer"})
	if err != nil || retained.Receipt.State != controlct.Uncertain || retained.Action != controlct.Message {
		t.Fatal("retained unknown message receipt unreadable", retained, err)
	}
	f.task.pipe.complete("turn-1")
	_, _ = g.Observe(ctx)
	second := f.selectTurn(t, 2)
	_, _ = second.runtime.Control().Message(ctx, controlct.FollowupRequest{OperationID: "changed-id", TaskID: "task", Message: req.Message})
	_, _ = second.Create(ctx, "replacement", TaskIngressCreateRequest{Message: "must not restart unknown effect"})
	op, err := f.task.store.Lookup(ctx, "lost-steer")
	snapshot, readErr := f.task.store.Read(ctx, "task")
	if err != nil || readErr != nil || op == nil || op.Settled || op.Intent.Action != task.Message || op.Intent.Expected != (task.Reference{ThreadID: "thread-exact", TurnID: "turn-1"}) || snapshot.Pending != "lost-steer" || snapshot.Task.DispatchID != "create" {
		t.Fatal("unknown original message was settled or replaced", op, snapshot, err, readErr)
	}
	if f.task.pipe.count("turn/steer") != 1 || f.task.pipe.count("turn/start") != 1 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("unknown effect repeated or selected a new provider")
	}
}

func TestTaskProfileMessageParentWithdrawalDuringProviderReadPreventsWrite(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	ctx := context.Background()
	if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "original"}); err != nil {
		t.Fatal(err)
	}
	var withdraw sync.Once
	f.task.pipe.mu.Lock()
	f.task.pipe.notifications = func(q taskIngressTestRPC) [][]byte {
		if q.Method == "thread/read" {
			withdraw.Do(func() {
				if err := f.parent.handle.Cancel(ctx); err != nil {
					t.Error(err)
				}
			})
		}
		return nil
	}
	f.task.pipe.mu.Unlock()
	_, _ = g.runtime.Control().Message(ctx, controlct.FollowupRequest{OperationID: "withdrawn-steer", TaskID: "task", Message: "must not send"})
	op, err := f.task.store.Lookup(ctx, "withdrawn-steer")
	if err != nil || op == nil || op.Settled || op.Intent.Action != task.Message || op.Intent.Expected.TurnID != "turn-1" || f.task.pipe.count("turn/steer") != 0 {
		t.Fatal("withdrawn parent sent or replaced its original intent", op, err)
	}
}

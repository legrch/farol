package boot

// Common framed desktop transport, actual Chat parent and retained Go Task
// profile/facades. Storage, host authority and Codex net.Pipe remain CPU doubles;
// these tests do not qualify native startup, an account or a live provider.
import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func taskSurfaceBody(t *testing.T, h *wire.TaskHandle, request any) string {
	t.Helper()
	body := map[string]any{"handleId": h.HandleId}
	if request != nil {
		body["request"] = request
	}
	switch request.(type) {
	case wire.TaskCreate, wire.TaskContinue, wire.TaskResume:
		body["deadlineMillis"] = strconv.FormatInt(time.Now().Add(29*time.Second).UnixMilli(), 10)
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

// Hermetic deadline coverage: controlled CPU ports and in-memory framing only.
func taskDeadlineBody(t *testing.T, handle string, deadline any) json.RawMessage {
	t.Helper()
	body := map[string]any{"handleId": handle, "request": wire.TaskCreate{Message: "initial"}}
	if deadline != nil {
		body["deadlineMillis"] = deadline
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTaskSurfaceDeadlineRejectsBeforeQualificationOrAdmission(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, method := range []string{"task.create", "task.continue", "task.resume"} {
		for _, value := range []any{nil, 1790000000000, "", "0", "-1", "01", "1.5", "NaN", "9223372036854775808", strconv.FormatInt(now.Add(-time.Second).UnixMilli(), 10), strconv.FormatInt(now.Add(time.Second).UnixMilli(), 10), strconv.FormatInt(now.Add(31*time.Second).UnixMilli(), 10)} {
			r := desktop.Request{RequestID: "deadline-request", OperationID: "create-1", Body: taskDeadlineBody(t, h.HandleId, value)}
			if method != "task.create" {
				body := map[string]any{"handleId": h.HandleId, "request": map[string]any{"dispatchId": "dispatch", "message": "continue"}}
				if value != nil {
					body["deadlineMillis"] = value
				}
				r.Body, err = json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
			}
			out, err := s.Methods()[method].Handle(context.Background(), r)
			if err != nil || out == nil || out.Status != "refused" || out.Code != "invalid_ingress_request" {
				t.Fatalf("invalid deadline %v did not refuse: %v %v", value, out, err)
			}
		}
	}
	if f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("deadline refusal reached qualification or durable admission")
	}
}

func TestTaskSurfaceDeadlineIsAbsoluteAndEarlierParentKeepsReserve(t *testing.T) {
	now := time.Now().Truncate(time.Millisecond)
	for _, parentBudget := range []time.Duration{time.Minute, 10 * time.Second} {
		parent, parentCancel := context.WithDeadline(context.Background(), now.Add(parentBudget))
		original := now.Add(29 * time.Second)
		// Seven seconds of prior work/queue time has already consumed the budget.
		ctx, cancel, err := taskEffectContext(parent, strconv.FormatInt(original.UnixMilli(), 10), now.Add(7*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		want := original
		if parentBudget < 29*time.Second {
			want = now.Add(parentBudget)
		}
		actual, _ := ctx.Deadline()
		execution, leave := taskProviderContext(ctx)
		exec, _ := execution.Deadline()
		wantExecution := original.Add(-2 * time.Second)
		if now.Add(parentBudget).Before(wantExecution) {
			wantExecution = now.Add(parentBudget)
		}
		if !actual.Equal(want) || !exec.Equal(wantExecution) || ctx.Value(taskExecutionDeadlineKey{}) != original.Add(-2*time.Second) {
			t.Fatal("deadline was renewed or reserve lost", actual, exec, want)
		}
		leave()
		cancel()
		parentCancel()
	}
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := taskEffectContext(parent, strconv.FormatInt(now.Add(29*time.Second).UnixMilli(), 10), now); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was reclassified as input refusal", err)
	}
}

type taskDeadlineCodexBoundary struct {
	codexclient.Boundary
	t        *testing.T
	want     time.Time
	ceiling  time.Duration
	observed []time.Time
}

func (b *taskDeadlineCodexBoundary) Verify(ctx context.Context, selected codexclient.Selection) error {
	deadline, ok := ctx.Deadline()
	if !ok || (b.ceiling == 0 && !deadline.Equal(b.want)) || (b.ceiling > 0 && time.Until(deadline) > b.ceiling) {
		b.t.Errorf("original selected provider has %v; want execution deadline %v", deadline, b.want)
	}
	b.observed = append(b.observed, deadline)
	return b.Boundary.Verify(ctx, selected)
}

// Exercise the production TaskRuntime injection and the original Codex client.
func TestTaskSurfaceDeadlineReachesOriginalCodexQualificationAndDispatch(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	deadline := time.Now().Add(2500 * time.Millisecond).Truncate(time.Millisecond)
	boundary := &taskDeadlineCodexBoundary{Boundary: f.task.pipe, t: t, want: deadline.Add(-2 * time.Second)}
	f.profile.newClient = func(selection codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		return codexclient.New(codexclient.Options{Selection: selection, Followup: q, Boundary: boundary, Now: func() time.Time { return selection.GrantedAt.Add(time.Minute) }, Recheck: grant, RecheckDispatch: dispatch})
	}
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Methods()["task.create"].Handle(context.Background(), desktop.Request{RequestID: "original-request", OperationID: "original-operation", Body: taskDeadlineBody(t, h.HandleId, strconv.FormatInt(deadline.UnixMilli(), 10))})
	if err != nil || out == nil || out.Status != "ok" {
		t.Fatal(out, err)
	}
	var mutation wire.TaskMutation
	if json.Unmarshal(out.Data, &mutation) != nil || mutation.OperationId != "original-operation" || mutation.Receipt.Reference.ThreadId == nil || mutation.Receipt.Reference.TurnId == nil {
		t.Fatal("deadline mapping changed original operation/lineage", string(out.Data))
	}
	if len(boundary.observed) < 2 || len(f.profile.clients) != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 {
		t.Fatal("qualification/dispatch did not retain original selected client")
	}
}

type taskDeadlineProviderTest struct {
	port.Provider
	support  func(context.Context) error
	dispatch func(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error)
}

func (p *taskDeadlineProviderTest) Supports(ctx context.Context, b task.Binding) (task.Capabilities, error) {
	if err := p.support(ctx); err != nil {
		return task.Capabilities{}, err
	}
	return p.Provider.Supports(ctx, b)
}
func (p *taskDeadlineProviderTest) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	return p.dispatch(ctx, d, progress)
}

type taskDeadlineJournalTest struct {
	*taskRuntimeTestMemory
	t          *testing.T
	settlement time.Time
	execution  time.Time
	finish     bool
}

func (j *taskDeadlineJournalTest) Finish(ctx context.Context, id string, receipt task.Receipt, next task.Task) error {
	deadline, ok := ctx.Deadline()
	if !ok || !deadline.Equal(j.settlement) {
		j.t.Fatal("journal lost original settlement budget", deadline, j.settlement)
	}
	// Simulate a durable settlement which completes after execution has ended.
	timer := time.NewTimer(time.Until(j.execution) + 10*time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return ctx.Err()
	}
	if ctx.Err() != nil {
		j.t.Fatal("provider context cancellation cancelled settlement")
	}
	j.finish = true
	return j.taskRuntimeTestMemory.Finish(ctx, id, receipt, next)
}

func TestTaskSurfaceDeadlineSettlementAndLostACKRetainOriginalOwner(t *testing.T) {
	for _, mode := range []string{"ack-before-execution", "ack-after-execution", "lost-ack"} {
		t.Run(mode, func(t *testing.T) {
			f := taskRuntimeTestNewFixture(t, task.Codex)
			deadline := time.Now().Add(2100 * time.Millisecond).Truncate(time.Millisecond)
			executionDeadline := deadline.Add(-2 * time.Second)
			journal := &taskDeadlineJournalTest{taskRuntimeTestMemory: f.journal, t: t, settlement: deadline, execution: executionDeadline}
			owner, err := taskrepo.New(journal, "task")
			if err != nil {
				t.Fatal(err)
			}
			route, err := owner.Select(f.route.Selection())
			if err != nil {
				t.Fatal(err)
			}
			dispatched := 0
			provider := &taskDeadlineProviderTest{Provider: f.provider, support: func(ctx context.Context) error {
				actual, _ := ctx.Deadline()
				if !actual.Equal(executionDeadline) {
					t.Fatal("Supports reset execution budget", actual)
				}
				return nil
			}, dispatch: func(ctx context.Context, d port.Dispatch, record func(task.Reference) error) (task.Receipt, error) {
				dispatched++
				actual, _ := ctx.Deadline()
				if !actual.Equal(executionDeadline) || d.Intent.OperationID != "create-1" {
					t.Fatal("Dispatch renewed deadline/identity", actual, d.Intent)
				}
				if err := record(taskRuntimeTestRef(task.Codex, "turn-1", "create-1")); err != nil {
					return task.Receipt{}, err
				}
				if mode != "ack-before-execution" {
					<-ctx.Done()
				}
				if mode == "lost-ack" {
					return task.Receipt{}, ctx.Err()
				}
				return task.Receipt{State: task.Known, Reference: taskRuntimeTestRef(task.Codex, "turn-1", "create-1"), Lifecycle: task.Running}, nil
			}}
			runtime, err := taskRuntime(TaskRuntimeInputs{Route: route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority}, provider)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel, err := taskEffectContext(context.Background(), strconv.FormatInt(deadline.UnixMilli(), 10), time.Now())
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			out, err := runtime.Control().Create(ctx, f.createRequest())
			if err != nil || out == nil || dispatched != 1 {
				t.Fatal(out, err, dispatched)
			}
			if mode == "lost-ack" {
				if out.Receipt.State != controlct.Uncertain || journal.finish {
					t.Fatal("lost ACK falsely settled/refused", out)
				}
				retained, err := runtime.Control().Operation(context.Background(), controlct.OperationRequest{OperationID: "create-1"})
				if err != nil || retained.Lineage.ThreadID != "thread-exact" || retained.OperationID != "create-1" {
					t.Fatal(retained, err)
				}
				_, _ = runtime.Control().Create(context.Background(), f.createRequest())
				if dispatched != 1 {
					t.Fatal("unknown operation replayed")
				}
			} else if out.Receipt.State != controlct.Known || !journal.finish {
				t.Fatal("valid ACK lost reserved settlement context", out)
			}
		})
	}
}

// Hermetic deadline coverage: controlled CPU ports and in-memory framing only.
func TestTaskSurfaceQueuedEffectCannotRenewItsOriginalDeadline(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	methods := s.Methods()
	entered, release := make(chan struct{}), make(chan struct{})
	methods["task.resolve"] = desktop.Method{Handle: func(context.Context, desktop.Request) (*desktop.Outcome, error) {
		close(entered)
		<-release
		return &desktop.Outcome{Status: "unavailable", Code: "controlled_queue_holder"}, nil
	}}
	peer := taskWireTestConnectMethods(t, methods, f.profile.peer)
	write := func(request wire.Request) error {
		raw, err := json.Marshal(request)
		if err != nil {
			return err
		}
		return ipc.WriteFrame(peer.in, raw)
	}
	first := wire.Request{Jsonrpc: "2.0", Id: "queue-holder", Method: "task.resolve", Params: wire.Call{Context: &peer.scope, Body: json.RawMessage(taskSurfaceBody(t, h, nil))}}
	if err := write(first); err != nil {
		t.Fatal(err)
	}
	<-entered
	// Only 50 ms of the execution window remains. While the original framed
	// request waits behind the selected serialized owner, that window expires.
	deadline := time.Now().Add(2050 * time.Millisecond).Truncate(time.Millisecond)
	op := "original-queued-operation"
	queued := wire.Request{Jsonrpc: "2.0", Id: "original-queued-request", Method: "task.create", Params: wire.Call{Context: &peer.scope, OperationId: &op, Body: taskDeadlineBody(t, h.HandleId, strconv.FormatInt(deadline.UnixMilli(), 10))}}
	writeDone := make(chan error, 1)
	go func() { writeDone <- write(queued) }()
	timer := time.NewTimer(time.Until(deadline.Add(-2*time.Second)) + 10*time.Millisecond)
	<-timer.C
	close(release)
	if _, err := ipc.ReadFrame(peer.out); err != nil {
		t.Fatal(err)
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
	raw, err := ipc.ReadFrame(peer.out)
	if err != nil {
		t.Fatal(err)
	}
	var response wire.Response
	if json.Unmarshal(raw, &response) != nil || response.Id == nil || *response.Id != queued.Id || response.Result == nil || response.Result.Status != "refused" || response.Result.OperationId == nil || *response.Result.OperationId != op {
		t.Fatal("queue renewed deadline/identity", string(raw))
	}
	if f.task.store.snapshot != nil || f.task.pipe.launches.Load() != 0 {
		t.Fatal("expired queued operation reached admission/provider")
	}
}

func TestTaskSurfaceQualificationConsumesExecutionButNotSettlementReserve(t *testing.T) {
	for _, ignoresDeadline := range []bool{false, true} {
		t.Run(strconv.FormatBool(ignoresDeadline), func(t *testing.T) {
			f := taskRuntimeTestNewFixture(t, task.Codex)
			deadline := time.Now().Add(2100 * time.Millisecond).Truncate(time.Millisecond)
			ctx, cancel, err := taskEffectContext(context.Background(), strconv.FormatInt(deadline.UnixMilli(), 10), time.Now())
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			provider := &taskDeadlineProviderTest{Provider: f.provider, support: func(execution context.Context) error {
				actual, _ := execution.Deadline()
				if !actual.Equal(deadline.Add(-2 * time.Second)) {
					t.Fatal("qualification reset original execution deadline", actual)
				}
				<-execution.Done()
				if ignoresDeadline {
					return nil
				}
				return execution.Err()
			}, dispatch: func(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
				t.Fatal("expired qualification reached effects")
				return task.Receipt{}, nil
			}}
			runtime, err := taskRuntime(TaskRuntimeInputs{Route: f.route, Binding: f.taskRuntimeTestAuthority.binding, Authority: f.taskRuntimeTestAuthority}, provider)
			if err != nil {
				t.Fatal(err)
			}
			_, err = runtime.Control().Create(ctx, f.createRequest())
			if err == nil || ctx.Err() != nil || f.journal.snapshot != nil {
				t.Fatal("qualification renewed budget, consumed reserve or admitted effect", err, ctx.Err())
			}
			// A cancellation is retained as cancellation/unknown, not a fake refusal.
			taskRuntimeTestRequireFailure(t, err, "TASK_REQUEST_CANCELLED")
		})
	}
}

func TestTaskSurfaceDeadlineKeepsExistingCodexAndGrantCeilings(t *testing.T) {
	for _, cap := range []time.Duration{20 * time.Second, 2 * time.Second} {
		t.Run(cap.String(), func(t *testing.T) {
			f := taskProfileTestSetup(t, false)
			deadline := time.Now().Add(29 * time.Second).Truncate(time.Millisecond)
			boundary := &taskDeadlineCodexBoundary{Boundary: f.task.pipe, t: t, ceiling: cap}
			f.profile.newClient = func(selection codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
				now := selection.GrantedAt.Add(time.Minute)
				if cap < 20*time.Second {
					now = selection.ExpiresAt.Add(-cap)
				}
				return codexclient.New(codexclient.Options{Selection: selection, Followup: q, Boundary: boundary, Now: func() time.Time { return now }, Recheck: grant, RecheckDispatch: dispatch})
			}
			s, err := NewTaskSurface(f.profile)
			if err != nil {
				t.Fatal(err)
			}
			h, err := s.SelectCodex(context.Background(), f.input)
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Methods()["task.create"].Handle(context.Background(), desktop.Request{RequestID: "original-request", OperationID: "original-operation", Body: taskDeadlineBody(t, h.HandleId, strconv.FormatInt(deadline.UnixMilli(), 10))})
			if err != nil || out == nil || out.Status != "ok" || len(boundary.observed) < 2 {
				t.Fatal("existing provider ceiling/composition failed", out, err, boundary.observed)
			}
		})
	}
}

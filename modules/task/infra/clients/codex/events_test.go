package codex

// The real producer, RPC parser, mapper and application run against an in-memory
// WebSocket peer and journal. No socket, executable, daemon or provider is used.
import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/contracts/observation"
	"github.com/legrch/farol/modules/task/domain"
	providerevents "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

type eventJournal struct {
	mu        sync.Mutex
	op        *port.Operation
	snapshot  *port.Snapshot
	failEvent bool
}

func (j *eventJournal) Lookup(_ context.Context, id string) (*port.Operation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.op == nil || j.op.Intent.OperationID != id {
		return nil, nil
	}
	out := *j.op
	out.Events.Events = append([]task.ExecutionEvent(nil), out.Events.Events...)
	return &out, nil
}
func (j *eventJournal) Read(_ context.Context, id string) (*port.Snapshot, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.snapshot == nil || j.snapshot.Task.ID != id {
		return nil, nil
	}
	out := *j.snapshot
	return &out, nil
}
func (j *eventJournal) Admit(_ context.Context, i task.Intent, revision uint64, next task.Task) (*port.Admission, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.op != nil {
		return nil, task.ErrConflict
	}
	if revision != 0 {
		return nil, task.ErrConflict
	}
	j.op = &port.Operation{Intent: i, Receipt: task.Receipt{State: task.Uncertain}}
	j.snapshot = &port.Snapshot{Task: next, Pending: i.OperationID, Revision: 1}
	return &port.Admission{Operation: *j.op, Snapshot: *j.snapshot, Claimed: true}, nil
}
func (j *eventJournal) Progress(_ context.Context, id string, ref task.Reference) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.op == nil || id != j.snapshot.Pending || !j.op.Lineage.Extend(ref, task.Codex) {
		return task.ErrIdentity
	}
	j.op.Lineage = ref
	return nil
}
func (j *eventJournal) Finish(_ context.Context, id string, receipt task.Receipt, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.op == nil || id != j.snapshot.Pending || j.op.Settled {
		return task.ErrState
	}
	j.op.Settled = true
	j.op.Receipt = receipt
	j.snapshot.Task = next
	j.snapshot.Pending = ""
	j.snapshot.Revision++
	return nil
}
func (j *eventJournal) Observe(_ context.Context, before port.Snapshot, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if before.Revision != j.snapshot.Revision || j.snapshot.Pending != "" || next.Reference != j.snapshot.Task.Reference {
		return task.ErrState
	}
	j.snapshot.Task = next
	j.snapshot.Revision++
	if next.Lifecycle.Terminal() {
		j.op.Receipt.Lifecycle = next.Lifecycle
		j.op.Receipt.Result = next.Result
	}
	return nil
}
func (j *eventJournal) RecordEvent(_ context.Context, e task.ExecutionEvent) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.failEvent {
		return task.ErrUnknown
	}
	if j.op == nil || e.Reference != j.op.Lineage || e.RunID != j.op.Intent.TaskID || e.DispatchID != j.op.Intent.OperationID {
		return task.ErrIdentity
	}
	next, err := j.op.Events.Append(e, task.Codex)
	if err == nil {
		j.op.Events = next
	}
	return err
}

type eventAuthority struct {
	binding task.Binding
	denied  bool
}

func (a *eventAuthority) Resolve(context.Context, port.Selection) (task.Binding, error) {
	return a.binding, nil
}
func (a *eventAuthority) Recheck(_ context.Context, b task.Binding) error {
	if a.denied || b != a.binding {
		return task.ErrIdentity
	}
	return nil
}
func (a *eventAuthority) RecheckParent(context.Context, task.Parent) error {
	if a.denied {
		return task.ErrIdentity
	}
	return nil
}
func eventService(t *testing.T, c *Client) (*tasksvc.Service, *eventJournal, *eventAuthority, tasksvc.CreateRequest) {
	t.Helper()
	j := &eventJournal{}
	a := &eventAuthority{binding: c.selection.Binding}
	c.recheck = a.Recheck
	s, err := tasksvc.New(j, a, map[task.Provider]port.Provider{task.Codex: c}, nil, intent.Fingerprint, providerevents.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	b := a.binding
	req := tasksvc.CreateRequest{OperationID: "event-dispatch", TaskID: "task-exact", Message: "bounded fixture", Selection: port.Selection{Provider: b.Provider, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: b.ModelAlias, Effort: b.Effort}, Parent: task.Parent{ThreadID: "initiator", TurnID: "initiator-turn"}}
	return s, j, a, req
}
func sendEvent(conn net.Conn, method string, params map[string]any) error {
	raw, err := json.Marshal(map[string]any{"method": method, "params": params})
	if err != nil {
		return err
	}
	return fixtureSend(conn, 1, raw)
}
func turnParams(turn string, status string) map[string]any {
	return map[string]any{"threadId": "thread-exact", "turn": map[string]any{"id": turn, "status": status}}
}
func itemParams(id, kind string) map[string]any {
	return map[string]any{"threadId": "thread-exact", "turnId": "turn-exact", "item": map[string]any{"id": id, "type": kind, "status": "completed", "exitCode": 0, "command": "PRIVATE_COMMAND", "text": strings.Repeat("PRIVATE_BODY", 7000), "output": "PRIVATE_OUTPUT"}}
}

func TestObservedProducerToJournalAndScopedContract(t *testing.T) {
	c, f := newFixture(t)
	s, j, a, req := eventService(t, c)
	f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
		if q.method == "turn/start" {
			if err := sendEvent(conn, "turn/started", turnParams("turn-exact", "inProgress")); err != nil {
				return err
			}
			if err := sendEvent(conn, "item/started", itemParams("cmd", "commandExecution")); err != nil {
				return err
			}
			for n := 0; n < 2; n++ {
				if err := sendEvent(conn, "item/completed", itemParams("cmd", "commandExecution")); err != nil {
					return err
				}
			}
			if err := sendEvent(conn, "item/completed", itemParams("claim", "agentMessage")); err != nil {
				return err
			}
			plan := map[string]any{"threadId": "thread-exact", "turnId": "turn-exact", "explanation": "PRIVATE_PLAN", "plan": []any{map[string]any{"step": "PRIVATE_STEP", "status": "completed"}, map[string]any{"step": "PRIVATE_STEP", "status": "pending"}}}
			if err := sendEvent(conn, "turn/plan/updated", plan); err != nil {
				return err
			}
			if err := sendEvent(conn, "turn/completed", turnParams("turn-exact", "completed")); err != nil {
				return err
			}
			foreign := turnParams("other-turn", "inProgress")
			foreign["threadId"] = "other-thread"
			return sendEvent(conn, "turn/started", foreign)
		}
		if q.method == "thread/read" {
			if err := sendEvent(conn, "item/completed", itemParams("late", "mcpToolCall")); err != nil {
				return err
			}
			return sendEvent(conn, "turn/completed", turnParams("turn-exact", "completed"))
		}
		return nil
	}
	created, err := s.Create(context.Background(), req)
	if err != nil || created.Receipt.State != task.Known {
		t.Fatal(created, err)
	}
	contract, err := observation.New(s)
	if err != nil {
		t.Fatal(err)
	}
	out, err := contract.Read(context.Background(), observation.Request{TaskID: req.TaskID, DispatchID: req.OperationID, Limit: 2, IncludeResult: true})
	if err != nil || len(out.Events) != 2 || !out.More || out.Retained || out.Lifecycle != "running" {
		t.Fatal(out, err)
	}
	next, err := contract.Read(context.Background(), observation.Request{TaskID: req.TaskID, DispatchID: req.OperationID, Cursor: out.Next, Limit: 32})
	if err != nil || len(next.Events) != 4 || next.More {
		t.Fatal(next, err)
	}
	if next.Events[0].Source != "provider_tool_receipt" || !next.Events[0].HasExitCode || next.Events[0].ExitCode != 0 || next.Events[1].Source != "advisory_model" || next.Events[2].CompletedSteps != 1 || next.Events[2].PlanSteps != 2 {
		t.Fatal(next)
	}
	op, _ := j.Lookup(context.Background(), req.OperationID)
	encoded, _ := json.Marshal(op.Events)
	if strings.Contains(string(encoded), "PRIVATE_") || op.Events.LastSequence != 6 || op.Events.LastSource != 7 {
		t.Fatal("private payload or bad dedup", string(encoded))
	}
	if next.Events[3].ReportedLifecycle != "completed" || next.Retained {
		t.Fatal("terminal notification became retained", next)
	}
	if len(f.seen("thread/read")) != 0 || f.launches.Load() != 1 {
		t.Fatal("read projection performed provider IO")
	}
	result, err := s.Result(context.Background(), tasksvc.ResultRequest{TaskID: req.TaskID})
	if err != nil || !result.Retained || result.Text != "source-only final" {
		t.Fatal(result, err)
	}
	final, err := contract.Read(context.Background(), observation.Request{TaskID: req.TaskID, DispatchID: req.OperationID, Limit: 32, IncludeResult: true})
	if err != nil || !final.Retained || final.Result != "source-only final" || final.ResultEvidence != "task_journal" || final.Delivery != "not_observed" || len(final.Events) != 7 || final.Events[5].ReportedLifecycle != "completed" {
		t.Fatal(final, err)
	}
	if len(f.seen("turn/start")) != 1 || f.launches.Load() != 1 {
		t.Fatal("metadata replayed effect")
	}
	a.denied = true
	if _, err := contract.Read(context.Background(), observation.Request{TaskID: req.TaskID, DispatchID: req.OperationID, Limit: 32}); err == nil {
		t.Fatal("revoked result disclosed")
	}
}

func TestObservedProducerRefMismatchAndUnknownPublicationNeverReplay(t *testing.T) {
	for _, mode := range []string{"lineage", "publication", "overflow", "conflict"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			s, j, _, req := eventService(t, c)
			j.failEvent = mode == "publication"
			f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
				if q.method != "turn/start" {
					return nil
				}
				turn := "turn-exact"
				if mode == "lineage" {
					turn = "unacknowledged-turn"
				}
				if mode == "conflict" {
					for _, code := range []int{0, 1} {
						params := itemParams("contradictory", "commandExecution")
						params["item"].(map[string]any)["exitCode"] = code
						if err := sendEvent(conn, "item/completed", params); err != nil {
							return err
						}
					}
					return nil
				}
				count := 1
				if mode == "overflow" {
					count = task.EventCapacity + 1
				}
				for n := 0; n < count; n++ {
					if err := sendEvent(conn, "turn/started", turnParams(turn, "inProgress")); err != nil {
						return err
					}
				}
				return nil
			}
			created, err := s.Create(context.Background(), req)
			if err != nil || created.Receipt.State != task.Uncertain {
				t.Fatal(created, err)
			}
			again, err := s.Create(context.Background(), req)
			if err != nil || again.Receipt.State != task.Uncertain {
				t.Fatal(again, err)
			}
			if len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 || f.launches.Load() != 1 {
				t.Fatal("unknown retried")
			}
			op, _ := j.Lookup(context.Background(), req.OperationID)
			expected := 0
			if mode == "conflict" {
				expected = 1
			}
			if op.Settled || len(op.Events.Events) != expected {
				t.Fatal("uncertain became success", op)
			}
			if _, err := c.Supports(context.Background(), c.selection.Binding); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("provider fence missing", err)
			}
		})
	}
}

// The follow-up adapter uses the same concrete client/mapper and existing
// eventJournal. The second journal stands for an already-admitted new intent;
// Root/Owner/common-wire composition remains a separate integration check.
func observedFollowupSetup(t *testing.T) (*Client, *pipeFixture, *eventJournal, port.Dispatch, *eventJournal) {
	t.Helper()
	c, f := newFollowupFixture(t)
	f.handle = func(q fixtureRequest) (any, bool) {
		switch q.method {
		case "turn/start":
			if len(f.seen("turn/start")) == 1 {
				return f.response(q)
			}
			return map[string]any{"turn": map[string]any{"id": "turn-followup"}}, false
		case "thread/turns/list":
			if len(f.seen("turn/start")) < 2 {
				return f.response(q)
			}
			return map[string]any{"data": []any{map[string]any{"id": "turn-followup", "status": "inProgress"}, map[string]any{"id": "turn-exact", "status": "completed"}}, "nextCursor": nil}, false
		}
		return f.response(q)
	}
	f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
		if q.method != "turn/start" {
			return nil
		}
		return sendEvent(conn, "turn/started", turnParams("turn-exact", "inProgress"))
	}
	s, old, _, req := eventService(t, c)
	created, err := s.Create(context.Background(), req)
	if err != nil || created.Receipt.State != task.Known || created.Receipt.Reference != completeRef() {
		t.Fatal("first dispatch setup", created, err)
	}
	final, err := s.Result(context.Background(), tasksvc.ResultRequest{TaskID: req.TaskID})
	if err != nil || !final.Retained || final.Text != "source-only final" {
		t.Fatal("first retained result setup", final, err)
	}
	d := followupDispatch(c.selection, "observed-followup")
	fresh := &eventJournal{}
	if _, err := fresh.Admit(context.Background(), d.Intent, 0, task.Task{}); err != nil {
		t.Fatal(err)
	}
	return c, f, old, d, fresh
}

func sendFollowupProgress(conn net.Conn) error {
	if err := sendEvent(conn, "turn/started", turnParams("turn-followup", "inProgress")); err != nil {
		return err
	}
	tool := itemParams("new-tool", "commandExecution")
	tool["turnId"] = "turn-followup"
	if err := sendEvent(conn, "item/completed", tool); err != nil {
		return err
	}
	plan := map[string]any{"threadId": "thread-exact", "turnId": "turn-followup", "explanation": "PRIVATE_PLAN", "plan": []any{map[string]any{"step": "PRIVATE_STEP", "status": "completed"}}}
	if err := sendEvent(conn, "turn/plan/updated", plan); err != nil {
		return err
	}
	claim := itemParams("new-claim", "agentMessage")
	claim["turnId"] = "turn-followup"
	if err := sendEvent(conn, "item/completed", claim); err != nil {
		return err
	}
	return sendEvent(conn, "turn/completed", turnParams("turn-followup", "completed"))
}

func TestObservedFollowupRetainsEarlyNewTurnAfterExactLineage(t *testing.T) {
	c, f, old, d, fresh := observedFollowupSetup(t)
	ctx := context.Background()
	before, _ := old.Lookup(ctx, "event-dispatch")
	beforeBytes, _ := json.Marshal(before)
	f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
		if q.method == "turn/start" {
			if err := sendEvent(conn, "turn/completed", turnParams("turn-exact", "completed")); err != nil {
				return err
			}
			if err := sendFollowupProgress(conn); err != nil {
				return err
			}
			return sendEvent(conn, "item/completed", itemParams("late-old-tool", "commandExecution"))
		}
		if q.method == "thread/turns/list" && len(f.seen("turn/start")) == 2 {
			return sendEvent(conn, "turn/completed", turnParams("turn-exact", "completed"))
		}
		return nil
	}
	published := 0
	receipt, err := c.DispatchObserved(ctx, d, func(ref task.Reference) error {
		if ref != followupRef() {
			t.Fatal("partial/parent follow-up lineage was published", ref)
		}
		op, _ := fresh.Lookup(ctx, d.Intent.OperationID)
		if len(op.Events.Events) != 0 || op.Lineage != (task.Reference{}) {
			t.Fatal("events escaped before new durable lineage", op)
		}
		c.eventMu.Lock()
		if c.events == nil || len(c.events.queued) != 5 {
			c.eventMu.Unlock()
			t.Fatal("new-turn metadata was not staged before ACK")
		}
		encoded, _ := json.Marshal(c.events.queued)
		c.eventMu.Unlock()
		if strings.Contains(string(encoded), "PRIVATE_") {
			t.Fatal("private body entered pending queue")
		}
		published++
		return fresh.Progress(ctx, d.Intent.OperationID, ref)
	}, fresh.RecordEvent)
	if err != nil || receipt.State != task.Known || receipt.Reference != followupRef() || published != 1 {
		t.Fatal("early progress lost follow-up", receipt, err, published)
	}
	op, _ := fresh.Lookup(ctx, d.Intent.OperationID)
	if len(op.Events.Events) != 5 || op.Events.LastSequence != 5 || op.Events.LastSource != 5 {
		t.Fatal("early compact facts lost or old events consumed sequence", op.Events)
	}
	for _, e := range op.Events.Events {
		if e.Reference != followupRef() || e.DispatchID != d.Intent.OperationID || e.Sequence == 0 {
			t.Fatal("event crossed dispatch/turn", e)
		}
	}
	if op.Events.StreamID == before.Events.StreamID || op.Settled {
		t.Fatal("follow-up reused stream or notification settled it", op)
	}
	if op.Events.Events[1].Source != task.ToolReceiptEvidence || op.Events.Events[2].CompletedSteps != 1 || op.Events.Events[3].Source != task.AdvisoryEvidence {
		t.Fatal("projection lost receipt/advisory distinction", op.Events)
	}
	after, _ := old.Lookup(ctx, "event-dispatch")
	afterBytes, _ := json.Marshal(after)
	if string(afterBytes) != string(beforeBytes) || !after.Settled || after.Receipt.Result != "source-only final" {
		t.Fatal("old-turn traffic contaminated retained result", after)
	}
	if f.launches.Load() != 1 || len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 2 {
		t.Fatal("progress required another effect or connection")
	}
}

func TestObservedFollowupRetiresOldRouteBeforeQualification(t *testing.T) {
	c, f, _, d, fresh := observedFollowupSetup(t)
	c.eventMu.Lock()
	c.events.record = func(context.Context, task.ExecutionEvent) error {
		return task.ErrIdentity // The prior owner is no longer this dispatch's sink.
	}
	c.eventMu.Unlock()
	f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
		if q.method == "model/list" {
			return sendEvent(conn, "turn/completed", turnParams("turn-exact", "completed"))
		}
		if q.method == "turn/start" {
			return sendFollowupProgress(conn)
		}
		return nil
	}
	r, err := c.DispatchObserved(context.Background(), d, func(ref task.Reference) error { return fresh.Progress(context.Background(), d.Intent.OperationID, ref) }, fresh.RecordEvent)
	if err != nil || r.State != task.Known || r.Reference != followupRef() {
		t.Fatal("late old route blocked selected follow-up", r, err)
	}
}

func TestObservedFollowupPublicationFailuresStayUnknownWithoutReplay(t *testing.T) {
	for _, mode := range []string{"lineage", "lineage-after-persist", "event", "event-after-persist", "crossed-first", "crossed-last", "lost-ack", "overflow", "authority", "epoch"} {
		t.Run(mode, func(t *testing.T) {
			c, f, old, d, fresh := observedFollowupSetup(t)
			before, _ := old.Lookup(context.Background(), "event-dispatch")
			beforeBytes, _ := json.Marshal(before)
			fresh.failEvent = mode == "event"
			var denied atomic.Bool
			c.recheck = func(context.Context, task.Binding) error {
				if denied.Load() {
					return task.ErrIdentity
				}
				return nil
			}
			f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
				if q.method != "turn/start" {
					return nil
				}
				if mode == "crossed-first" {
					if err := sendEvent(conn, "turn/started", turnParams("crossed-turn", "inProgress")); err != nil {
						return err
					}
				}
				if mode == "authority" {
					denied.Store(true)
				}
				if mode == "epoch" {
					if err := sendEvent(conn, "account/updated", map[string]any{}); err != nil {
						return err
					}
				}
				if err := sendFollowupProgress(conn); err != nil {
					return err
				}
				if mode == "crossed-last" {
					return sendEvent(conn, "turn/started", turnParams("crossed-turn", "inProgress"))
				}
				if mode == "overflow" {
					for n := 0; n < task.EventCapacity; n++ {
						if err := sendEvent(conn, "turn/started", turnParams("turn-followup", "inProgress")); err != nil {
							return err
						}
					}
				}
				if mode == "lost-ack" {
					return errors.New("source-only lost follow-up ACK")
				}
				return nil
			}
			calls := 0
			r, err := c.DispatchObserved(context.Background(), d, func(ref task.Reference) error {
				if mode == "lineage" {
					return task.ErrUnknown
				}
				if err := fresh.Progress(context.Background(), d.Intent.OperationID, ref); err != nil {
					return err
				}
				if mode == "lineage-after-persist" {
					return task.ErrUnknown
				}
				return nil
			}, func(ctx context.Context, e task.ExecutionEvent) error {
				calls++
				if err := fresh.RecordEvent(ctx, e); err != nil {
					return err
				}
				if mode == "event-after-persist" {
					return task.ErrUnknown
				}
				return nil
			})
			if err != nil || r.State != task.Uncertain {
				t.Fatal("failed publication became known", r, err)
			}
			expectedCalls := 0
			if mode == "event" || mode == "event-after-persist" {
				expectedCalls = 1
			}
			if calls != expectedCalls {
				t.Fatal("invalid queue partially published", calls)
			}
			op, _ := fresh.Lookup(context.Background(), d.Intent.OperationID)
			expectedEvents := 0
			if mode == "event-after-persist" {
				expectedEvents = 1 // A lost publication ACK cannot erase a durable fact.
			}
			if len(op.Events.Events) != expectedEvents || op.Settled {
				t.Fatal("unknown publication lost its exact bounded evidence", op)
			}
			for _, id := range []string{d.Intent.OperationID, "different-follow-up"} {
				next := d
				next.Intent.OperationID = id
				again, err := c.DispatchObserved(context.Background(), next, func(task.Reference) error { t.Fatal("late lineage replay"); return nil }, func(context.Context, task.ExecutionEvent) error { t.Fatal("late event replay"); return nil })
				if err != nil || again.State != task.Uncertain {
					t.Fatal("uncertainty allowed another effect", again, err)
				}
			}
			if _, err := c.Supports(context.Background(), c.selection.Binding); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("unknown capability fence missing", err)
			}
			after, _ := old.Lookup(context.Background(), "event-dispatch")
			afterBytes, _ := json.Marshal(after)
			if string(afterBytes) != string(beforeBytes) {
				t.Fatal("failure changed old retained result")
			}
			c.eventMu.Lock()
			active := c.events != nil
			c.eventMu.Unlock()
			if active || f.launches.Load() != 1 || len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 2 {
				t.Fatal("unknown retained route or repeated effect")
			}
		})
	}
}

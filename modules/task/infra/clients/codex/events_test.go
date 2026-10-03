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

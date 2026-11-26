package codex

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	task "github.com/legrch/farol/modules/task/domain"
)

func TestSourceOnlyLostMutationAcknowledgementIsSticky(t *testing.T) {
	for _, method := range []string{"thread/start", "turn/start"} {
		t.Run(method, func(t *testing.T) {
			c, f := newFixture(t)
			f.handle = func(r fixtureRequest) (any, bool) {
				if r.method == method {
					return nil, true
				}
				return f.response(r)
			}
			var refs []task.Reference
			d := dispatch(c.selection, "lost-ack")
			r, err := c.Create(context.Background(), d, func(ref task.Reference) error { refs = append(refs, ref); return nil })
			if err != nil || r.State != task.Uncertain {
				t.Fatalf("lost ACK: %+v %v", r, err)
			}
			if method == "thread/start" && (len(refs) != 0 || r.Reference != (task.Reference{})) {
				t.Fatal("invented lost thread lineage")
			}
			if method == "turn/start" && (len(refs) != 1 || r.Reference != (task.Reference{ThreadID: "thread-exact"})) {
				t.Fatal("lost retained thread lineage")
			}
			for _, id := range []string{"lost-ack", "different-operation"} {
				again, _ := c.Create(context.Background(), dispatch(c.selection, id), func(task.Reference) error { t.Fatal("late callback"); return nil })
				if again.State != task.Uncertain {
					t.Fatalf("replay: %+v", again)
				}
			}
			if _, err := c.Supports(context.Background(), c.selection.Binding); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("uncertainty did not fence capabilities")
			}
			if _, err := c.Observe(context.Background(), c.selection.Binding, completeRef()); err == nil {
				t.Fatal("lost connection observed success")
			}
			if f.launches.Load() != 1 || len(f.seen(method)) != 1 {
				t.Fatal("mutation/proxy repeated")
			}
		})
	}
}
func TestSourceOnlyCallbackFailureStopsMutation(t *testing.T) {
	for _, at := range []int{1, 2} {
		t.Run(string(rune('0'+at)), func(t *testing.T) {
			c, f := newFixture(t)
			calls := 0
			r, _ := c.Create(context.Background(), dispatch(c.selection, "callback-fails"), func(task.Reference) error {
				calls++
				if calls == at {
					return task.ErrUnknown
				}
				return nil
			})
			if r.State != task.Uncertain || calls != at {
				t.Fatalf("callback failure: %+v calls %d", r, calls)
			}
			if at == 1 && (r.Reference.TurnID != "" || len(f.seen("turn/start")) != 0) {
				t.Fatal("turn sent after failed thread persistence")
			}
			if at == 2 && r.Reference != completeRef() {
				t.Fatal("complete uncertain lineage lost")
			}
			later, _ := c.Create(context.Background(), dispatch(c.selection, "new-after-callback"), func(task.Reference) error { return nil })
			if later.State != task.Uncertain || len(f.seen("thread/start")) != 1 {
				t.Fatal("callback fence bypassed")
			}
		})
	}
}
func TestSourceOnlyQualificationFailuresHaveNoMutation(t *testing.T) {
	for _, mode := range []string{"physical", "grant", "expired", "launch", "upgrade", "initialize-home", "model", "effort", "default-missing", "project", "ambiguous-project", "wrong-binding", "omitted-effective-effort"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			d := dispatch(c.selection, "qualification")
			switch mode {
			case "physical":
				f.valid.Store(false)
			case "grant":
				c.recheck = func(context.Context, task.Binding) error { return task.ErrIdentity }
			case "expired":
				c.now = func() time.Time { return c.selection.ExpiresAt }
			case "launch":
				f.launchError = true
			case "upgrade":
				f.badHandshake = true
			case "wrong-binding":
				d.Intent.Binding.HostID = "other-host"
			case "omitted-effective-effort":
				c.selection.Binding.Effort = ""
				f.selection = c.selection
				d.Intent.Binding = c.selection.Binding
			}
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := f.response(q)
				m, _ := v.(map[string]any)
				if mode == "initialize-home" && q.method == "initialize" {
					m["codexHome"] = "/other/home"
				}
				if q.method == "model/list" {
					rows := m["data"].([]any)
					row := rows[0].(map[string]any)
					switch mode {
					case "model":
						row["model"] = "other-model"
					case "effort":
						row["supportedReasoningEfforts"] = []any{}
						row["defaultReasoningEffort"] = nil
					case "default-missing":
						delete(row, "defaultReasoningEffort")
					}
				}
				if q.method == "project/list" {
					switch mode {
					case "project":
						m["data"] = []any{}
					case "ambiguous-project":
						m["data"] = append(m["data"].([]any), map[string]any{"id": "other-project", "roots": []any{map[string]any{"path": c.selection.Binding.Project.Path}}})
					}
				}
				return v, drop
			}
			r, _ := c.Create(context.Background(), d, func(task.Reference) error { t.Fatal("unqualified lineage"); return nil })
			if r.State != task.Rejected || len(f.seen("thread/start")) != 0 || len(f.seen("turn/start")) != 0 {
				t.Fatalf("qualification: %+v", r)
			}
		})
	}
}
func TestSourceOnlyMalformedMutationReplyFences(t *testing.T) {
	for _, mode := range []string{"thread-model", "thread-root", "thread-project", "sandbox", "turn-id", "response-id", "duplicate-key"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			if mode == "response-id" {
				f.badID = "thread/start"
			}
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := f.response(q)
				m, _ := v.(map[string]any)
				if q.method == "thread/start" {
					switch mode {
					case "thread-model":
						m["model"] = "other"
					case "thread-root":
						m["cwd"] = "/other/writer"
					case "thread-project":
						m["thread"].(map[string]any)["projectId"] = "other"
					case "sandbox":
						m["sandbox"] = map[string]any{"type": "dangerFullAccess"}
					case "duplicate-key":
						return json.RawMessage(`{"thread":{"id":"one","id":"two"}}`), false
					}
				}
				if q.method == "turn/start" && mode == "turn-id" {
					m["turn"] = map[string]any{"id": ""}
				}
				return v, drop
			}
			r, _ := c.Create(context.Background(), dispatch(c.selection, "malformed"), func(task.Reference) error { return nil })
			if r.State != task.Uncertain {
				t.Fatalf("malformed mutation: %+v", r)
			}
			again, _ := c.Create(context.Background(), dispatch(c.selection, "after-malformed"), func(task.Reference) error { return nil })
			if again.State != task.Uncertain || len(f.seen("thread/start")) != 1 {
				t.Fatal("malformed reply authorized a second effect")
			}
		})
	}
}

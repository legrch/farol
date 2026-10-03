package codex

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/domain"
)

func TestSourceOnlySelectedCreateAndObserve(t *testing.T) {
	c, f := newFixture(t)
	if f.checks.Load() != 0 || f.launches.Load() != 0 {
		t.Fatal("constructor performed host operations")
	}
	caps, err := c.Supports(context.Background(), c.selection.Binding)
	if err != nil || caps != (task.Capabilities{Create: true}) {
		t.Fatalf("capabilities: %+v %v", caps, err)
	}
	var refs []task.Reference
	r, err := c.Create(context.Background(), dispatch(c.selection, "operation-one"), func(ref task.Reference) error { refs = append(refs, ref); return nil })
	if err != nil || r.State != task.Known || r.Reference != completeRef() || r.Lifecycle != task.Running {
		t.Fatalf("create: %+v %v", r, err)
	}
	if !reflect.DeepEqual(refs, []task.Reference{{ThreadID: "thread-exact"}, completeRef()}) {
		t.Fatalf("lineage: %+v", refs)
	}
	if f.launches.Load() != 1 || len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 {
		t.Fatal("wrong proxy/effect count")
	}
	start := f.seen("thread/start")[0].params
	turn := f.seen("turn/start")[0].params
	if !equals(start, "projectId", c.selection.Binding.ProjectID) || !equals(start, "cwd", c.selection.Binding.Writer.Path) || !equals(start, "model", c.selection.Binding.Model) {
		t.Fatal("thread route not exact")
	}
	if fallback, ok := boolean(start, "allowProviderModelFallback"); !ok || fallback {
		t.Fatal("model fallback enabled")
	}
	if ephemeral, ok := boolean(start, "ephemeral"); !ok || ephemeral {
		t.Fatal("persistent thread not requested")
	}
	policy, ok := object(turn, "sandboxPolicy")
	network, haveNetwork := boolean(policy, "networkAccess")
	roots, haveRoots := array(policy, "writableRoots", 1)
	if !equals(turn, "threadId", "thread-exact") || !equals(turn, "effort", "high") || !ok || !haveNetwork || network || !haveRoots || string(roots[0]) != `"/fixture/writer"` {
		t.Fatal("turn policy not exact")
	}
	o, err := c.Observe(context.Background(), c.selection.Binding, completeRef())
	if err != nil || o.Reference != completeRef() || o.Lifecycle != task.Completed || o.Result != "source-only final" {
		t.Fatalf("observe: %+v %v", o, err)
	}
	if f.launches.Load() != 1 {
		t.Fatal("observation reconnected")
	}
}
func TestSourceOnlyUnsupportedControlsDoNotLaunch(t *testing.T) {
	c, f := newFixture(t)
	d := dispatch(c.selection, "unsupported")
	for _, method := range []task.Action{task.Continue, task.Message, task.Cancel} {
		var r task.Receipt
		var err error
		switch method {
		case task.Continue:
			r, err = c.Continue(context.Background(), d, nil)
		case task.Message:
			r, err = c.Message(context.Background(), d, nil)
		case task.Cancel:
			r, err = c.Cancel(context.Background(), d, nil)
		}
		if !errors.Is(err, task.ErrUnsupported) || r.State != task.Rejected {
			t.Fatalf("%s: %+v %v", method, r, err)
		}
	}
	if f.launches.Load() != 0 || f.checks.Load() != 0 {
		t.Fatal("unsupported control reached boundary")
	}
}
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
func TestSourceOnlyRecheckAfterThreadPreventsTurn(t *testing.T) {
	for _, mode := range []string{"physical", "grant", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			valid := true
			now := c.now()
			c.recheck = func(context.Context, task.Binding) error {
				if !valid {
					return task.ErrIdentity
				}
				return nil
			}
			c.now = func() time.Time { return now }
			r, _ := c.Create(context.Background(), dispatch(c.selection, "changed-selection"), func(task.Reference) error {
				switch mode {
				case "physical":
					f.valid.Store(false)
				case "grant":
					valid = false
				case "expiry":
					now = c.selection.ExpiresAt
				}
				return nil
			})
			if r.State != task.Uncertain || r.Reference.ThreadID != "thread-exact" || len(f.seen("turn/start")) != 0 {
				t.Fatalf("changed selection: %+v", r)
			}
		})
	}
}
func TestSourceOnlyOperationFenceRetainsAndRejectsConflict(t *testing.T) {
	c, f := newFixture(t)
	d := dispatch(c.selection, "operation-fence")
	first, _ := c.Create(context.Background(), d, func(task.Reference) error { return nil })
	if first.State != task.Known {
		t.Fatal(first)
	}
	again, _ := c.Create(context.Background(), d, func(task.Reference) error { t.Fatal("replay callback"); return nil })
	if again.State != task.Uncertain {
		t.Fatal(again)
	}
	d.Message = "changed source-only request"
	conflict, _ := c.Create(context.Background(), d, func(task.Reference) error { return nil })
	if conflict.State != task.Rejected || conflict.Code != "CODEX_OPERATION_CONFLICT" {
		t.Fatal(conflict)
	}
	if len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 {
		t.Fatal("replayed provider effect")
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
func TestSourceOnlyObserveExactAndUniqueTerminal(t *testing.T) {
	for _, mode := range []string{"running", "failed", "interrupted", "wrong-thread", "wrong-model", "missing-turn", "duplicate-turn-across-pages", "unknown-turn-status", "no-final", "duplicate-final", "wrong-item-turn", "non-final", "cursor-cycle", "trailing-json", "oversized-result"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			turnPages := 0
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := f.response(q)
				m, _ := v.(map[string]any)
				if q.method == "thread/read" {
					switch mode {
					case "wrong-thread":
						m["thread"].(map[string]any)["id"] = "other-thread"
					case "wrong-model":
						m["thread"].(map[string]any)["model"] = "other-model"
					}
				}
				if q.method == "thread/turns/list" {
					rows := m["data"].([]any)
					row := rows[0].(map[string]any)
					switch mode {
					case "running":
						row["status"] = "inProgress"
					case "failed":
						row["status"] = "failed"
					case "interrupted":
						row["status"] = "interrupted"
					case "missing-turn":
						row["id"] = "other-turn"
					case "unknown-turn-status":
						row["status"] = "queued"
					case "duplicate-turn-across-pages":
						turnPages++
						if turnPages == 1 {
							m["nextCursor"] = "page-two"
						}
					case "cursor-cycle":
						row["id"] = "other-turn-" + string(rune('0'+turnPages))
						turnPages++
						m["nextCursor"] = "repeat"
					}
				}
				if q.method == "thread/items/list" {
					rows := m["data"].([]any)
					row := rows[0].(map[string]any)
					item := row["item"].(map[string]any)
					switch mode {
					case "no-final":
						m["data"] = []any{}
					case "duplicate-final":
						m["data"] = append(rows, map[string]any{"turnId": "turn-exact", "item": map[string]any{"id": "second-final", "type": "agentMessage", "phase": "final_answer", "text": "ambiguous"}})
					case "wrong-item-turn":
						row["turnId"] = "other-turn"
					case "non-final":
						item["phase"] = "commentary"
					case "trailing-json":
						return json.RawMessage(`{} {}`), false
					case "oversized-result":
						item["text"] = strings.Repeat("x", maxResultBytes+1)
					}
				}
				return v, drop
			}
			o, err := c.Observe(context.Background(), c.selection.Binding, completeRef())
			want := task.Unknown
			switch mode {
			case "running":
				want = task.Running
			case "failed":
				want = task.Failed
			case "interrupted":
				want = task.Interrupted
			}
			if want == task.Unknown {
				if err == nil {
					t.Fatalf("ambiguous observation accepted: %+v", o)
				}
			} else if err != nil || o.Lifecycle != want || o.Result != "" {
				t.Fatalf("observation: %+v %v", o, err)
			}
			if len(f.seen("thread/start")) != 0 || len(f.seen("turn/start")) != 0 {
				t.Fatal("observation dispatched work")
			}
		})
	}
}
func TestSourceOnlyFailedConnectionNeverRelaunches(t *testing.T) {
	for _, mode := range []string{"launch", "initialize", "cleanup"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			if mode == "launch" {
				f.launchError = true
			} else if mode == "initialize" {
				f.badHandshake = true
			} else {
				f.waitUnknown = true
			}
			_, _ = c.Supports(context.Background(), c.selection.Binding)
			_ = c.Close(context.Background())
			_, _ = c.Supports(context.Background(), c.selection.Binding)
			if f.launches.Load() != 1 {
				t.Fatal("client relaunched after failure/close")
			}
			if mode == "cleanup" {
				if err := c.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
					t.Fatal("missing cleanup proof accepted")
				}
			}
		})
	}
}

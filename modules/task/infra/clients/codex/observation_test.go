package codex

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	task "github.com/legrch/farol/modules/task/domain"
)

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

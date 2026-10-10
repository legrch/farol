package codex

// These tests use only the inherited net.Pipe fixture, never NativeBoundary.
import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func followupQualification(s Selection) FollowupQualification {
	return FollowupQualification{Selection: s, Witness: FollowupSchemaWitness{Kind: FollowupSchemaKind, Protocol: s.Protocol, BaseSchemaSHA256: s.SchemaSHA256, SchemaSHA256: strings.Repeat("e", 64)}}
}
func newFollowupFixture(t *testing.T) (*Client, *pipeFixture) {
	t.Helper()
	s := testSelection()
	f := &pipeFixture{selection: s}
	f.valid.Store(true)
	c, err := New(Options{Selection: s, Followup: followupQualification(s), Boundary: f, Now: func() time.Time { return s.GrantedAt.Add(time.Minute) }, Recheck: func(context.Context, task.Binding) error { return nil }, RecheckDispatch: fixtureDispatchCheck})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	f.handle = func(q fixtureRequest) (any, bool) { return followupResponse(f, q) }
	return c, f
}
func followupDispatch(s Selection, id string) port.Dispatch {
	d := dispatch(s, id)
	d.Intent.Action, d.Intent.Expected = task.Continue, completeRef()
	d.Intent.Admission = task.AdmissionBinding{OwnerID: "owner", SessionID: "farol-session", TaskID: d.Intent.TaskID, TaskEpoch: 2, ParticipantID: "participant", TurnID: "fresh-farol-turn"}
	return d
}
func followupRef() task.Reference {
	return task.Reference{ThreadID: "thread-exact", TurnID: "turn-followup"}
}
func followupResponse(f *pipeFixture, q fixtureRequest) (any, bool) {
	switch q.method {
	case "turn/start":
		return map[string]any{"turn": map[string]any{"id": "turn-followup"}}, false
	case "thread/turns/list":
		rows := []any{map[string]any{"id": "turn-exact", "status": "completed"}}
		if len(f.seen("turn/start")) > 0 {
			rows = append([]any{map[string]any{"id": "turn-followup", "status": "inProgress"}}, rows...)
		}
		return map[string]any{"data": rows, "nextCursor": "older-history"}, false
	}
	return f.response(q)
}

func TestSourceOnlyFollowupQualificationBindsWholeSelection(t *testing.T) {
	mutations := map[string]func(*FollowupQualification){
		"kind":              func(q *FollowupQualification) { q.Witness.Kind = "baseline" },
		"protocol":          func(q *FollowupQualification) { q.Witness.Protocol = "v1" },
		"baseline":          func(q *FollowupQualification) { q.Witness.BaseSchemaSHA256 = strings.Repeat("f", 64) },
		"same-digest":       func(q *FollowupQualification) { q.Witness.SchemaSHA256 = q.Witness.BaseSchemaSHA256 },
		"invalid-digest":    func(q *FollowupQualification) { q.Witness.SchemaSHA256 = "invalid" },
		"profile":           func(q *FollowupQualification) { q.Selection.Binding.ProfileID = "other" },
		"host":              func(q *FollowupQualification) { q.Selection.Binding.HostID = "other" },
		"project":           func(q *FollowupQualification) { q.Selection.Binding.ProjectID = "other" },
		"physical-project":  func(q *FollowupQualification) { q.Selection.Binding.Project.Inode = "99" },
		"physical-writer":   func(q *FollowupQualification) { q.Selection.Binding.Writer.Inode = "99" },
		"workspace":         func(q *FollowupQualification) { q.Selection.Binding.WorkspaceID = "other" },
		"model":             func(q *FollowupQualification) { q.Selection.Binding.Model = "other" },
		"effort":            func(q *FollowupQualification) { q.Selection.Binding.Effort = "low" },
		"config":            func(q *FollowupQualification) { q.Selection.Binding.ConfigDigest = strings.Repeat("f", 64) },
		"executable":        func(q *FollowupQualification) { q.Selection.ExecutablePath = "/other/bin" },
		"executable-digest": func(q *FollowupQualification) { q.Selection.ExecutableSHA256 = strings.Repeat("f", 64) },
		"socket":            func(q *FollowupQualification) { q.Selection.SocketPath = "/other/socket" },
		"home":              func(q *FollowupQualification) { q.Selection.ExpectedCodexHome = "/other/home" },
		"scratch":           func(q *FollowupQualification) { q.Selection.ScratchRoot = "/other/scratch" },
		"sandbox":           func(q *FollowupQualification) { q.Selection.Sandbox = "read-only" },
		"approval":          func(q *FollowupQualification) { q.Selection.ApprovalPolicy = "on-request" },
		"granted":           func(q *FollowupQualification) { q.Selection.GrantedAt = q.Selection.GrantedAt.Add(time.Second) },
		"expires":           func(q *FollowupQualification) { q.Selection.ExpiresAt = q.Selection.ExpiresAt.Add(time.Second) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s := testSelection()
			f := &pipeFixture{selection: s}
			q := followupQualification(s)
			mutate(&q)
			_, err := New(Options{Selection: s, Followup: q, Boundary: f, Now: time.Now, Recheck: func(context.Context, task.Binding) error { return nil }, RecheckDispatch: fixtureDispatchCheck})
			if !errors.Is(err, task.ErrInvalid) || f.launches.Load() != 0 || f.checks.Load() != 0 {
				t.Fatal("unbound witness accepted or host reached")
			}
		})
	}
}

func TestSourceOnlyContinueStartsNewTurnOnExactCompletedThread(t *testing.T) {
	c, f := newFollowupFixture(t)
	before := c.selection
	if f.launches.Load() != 0 || f.checks.Load() != 0 {
		t.Fatal("constructor reached host")
	}
	caps, err := c.Supports(context.Background(), before.Binding)
	if err != nil || caps != (task.Capabilities{Create: true, Continue: true, Message: true}) {
		t.Fatalf("caps: %+v %v", caps, err)
	}
	var refs []task.Reference
	r, err := c.Dispatch(context.Background(), followupDispatch(before, "fresh-followup"), func(ref task.Reference) error { refs = append(refs, ref); return nil })
	if err != nil || r.State != task.Known || r.Reference != followupRef() || r.Lifecycle != task.Running || !reflect.DeepEqual(refs, []task.Reference{followupRef()}) {
		t.Fatalf("followup: %+v %v refs %+v", r, err, refs)
	}
	if c.selection != before || f.launches.Load() != 1 || len(f.seen("thread/start")) != 0 || len(f.seen("turn/start")) != 1 {
		t.Fatal("selection changed or wrong effect count")
	}
	turn := f.seen("turn/start")[0].params
	policy, ok := object(turn, "sandboxPolicy")
	network, haveNetwork := boolean(policy, "networkAccess")
	roots, haveRoots := array(policy, "writableRoots", 1)
	if !equals(turn, "threadId", completeRef().ThreadID) || !equals(turn, "cwd", before.Binding.Writer.Path) || !equals(turn, "model", before.Binding.Model) || !equals(turn, "effort", before.Binding.Effort) || !equals(turn, "approvalPolicy", before.ApprovalPolicy) || !ok || !equals(policy, "type", "workspaceWrite") || !haveNetwork || network || !haveRoots || len(roots) != 1 || string(roots[0]) != `"/fixture/writer"` {
		t.Fatal("turn binding/policy not exact")
	}
	queries := f.seen("thread/turns/list")
	if len(queries) != 2 {
		t.Fatal("missing history witnesses")
	}
	for j, q := range queries {
		if !equals(q.params, "threadId", completeRef().ThreadID) || !equals(q.params, "sortDirection", "desc") || !equals(q.params, "itemsView", "notLoaded") || string(q.params["cursor"]) != "null" || string(q.params["limit"]) != []string{"1", "2"}[j] {
			t.Fatal("history witness not exact")
		}
	}
}

func TestSourceOnlyContinueRejectsBeforeEffect(t *testing.T) {
	for _, mode := range []string{"wrong-action", "no-admission", "wrong-task", "incomplete", "wrong-binding", "message-empty", "message-large", "no-progress", "thread", "project", "writer", "model", "not-latest", "failed", "interrupted", "running", "empty-history", "extra-history", "bad-cursor", "pre-grant-change"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFollowupFixture(t)
			d := followupDispatch(c.selection, "reject-before-effect")
			progress := func(task.Reference) error { t.Fatal("unexpected lineage"); return nil }
			switch mode {
			case "wrong-action":
				d.Intent.Action = task.Message
			case "no-admission":
				d.Intent.Admission = task.AdmissionBinding{}
			case "wrong-task":
				d.Intent.Admission.TaskID = "other-task"
			case "incomplete":
				d.Intent.Expected.TurnID = ""
			case "wrong-binding":
				d.Intent.Binding.HostID = "other"
			case "message-empty":
				d.Message = " "
			case "message-large":
				d.Message = strings.Repeat("x", 8193)
			case "no-progress":
				progress = nil
			}
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := followupResponse(f, q)
				m, _ := v.(map[string]any)
				if q.method == "thread/read" {
					thread := m["thread"].(map[string]any)
					switch mode {
					case "thread":
						thread["id"] = "other"
					case "project":
						thread["projectId"] = "other"
					case "writer":
						thread["cwd"] = "/other/writer"
					case "model":
						thread["model"] = "other"
					}
				}
				if q.method == "thread/turns/list" {
					rows := m["data"].([]any)
					parent := rows[0].(map[string]any)
					switch mode {
					case "not-latest":
						parent["id"] = "other-latest"
					case "failed", "interrupted":
						parent["status"] = mode
					case "running":
						parent["status"] = "inProgress"
					case "empty-history":
						m["data"] = []any{}
					case "extra-history":
						m["data"] = append(rows, parent)
					case "bad-cursor":
						m["nextCursor"] = 1
					case "pre-grant-change":
						f.valid.Store(false)
					}
				}
				return v, drop
			}
			r, err := c.Continue(context.Background(), d, progress)
			if err != nil || r.State != task.Rejected || len(f.seen("turn/start")) != 0 || len(f.seen("thread/start")) != 0 {
				t.Fatalf("before effect: %+v %v", r, err)
			}
		})
	}
}

func TestSourceOnlyContinueUncertaintyRetainsLineageAndNeverReplays(t *testing.T) {
	for _, mode := range []string{"lost-ack", "same-turn-ack", "invalid-turn-ack", "callback", "panic", "wrong-pair", "changed-parent", "parent-failed", "missing-pair", "extra-pair", "duplicate-pair", "invalid-status", "bad-cursor", "physical", "grant", "expiry", "epoch", "lost-post-history"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFollowupFixture(t)
			d := followupDispatch(c.selection, "uncertain-followup")
			ref := completeRef()
			calls := 0
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := followupResponse(f, q)
				m, _ := v.(map[string]any)
				if q.method == "turn/start" {
					switch mode {
					case "lost-ack":
						return nil, true
					case "same-turn-ack":
						m["turn"].(map[string]any)["id"] = ref.TurnID
					case "invalid-turn-ack":
						m["turn"].(map[string]any)["id"] = "bad/id"
					}
				}
				if q.method == "thread/turns/list" && len(f.seen("turn/start")) > 0 {
					rows := m["data"].([]any)
					first, parent := rows[0].(map[string]any), rows[1].(map[string]any)
					switch mode {
					case "wrong-pair":
						first["id"] = "other-new"
					case "changed-parent":
						parent["id"] = "concurrent-turn"
					case "parent-failed":
						parent["status"] = "failed"
					case "missing-pair":
						m["data"] = rows[:1]
					case "extra-pair":
						m["data"] = append(rows, parent)
					case "duplicate-pair":
						parent["id"] = first["id"]
					case "invalid-status":
						first["status"] = "unknown-state"
					case "bad-cursor":
						delete(m, "nextCursor")
					case "lost-post-history":
						return nil, true
					}
				}
				return v, drop
			}
			r, err := c.Continue(context.Background(), d, func(got task.Reference) error {
				calls++
				ref = got
				switch mode {
				case "callback":
					return task.ErrUnknown
				case "panic":
					panic("fixture persistence failure")
				case "physical":
					f.valid.Store(false)
				case "grant":
					c.recheck = func(context.Context, task.Binding) error { return task.ErrIdentity }
				case "expiry":
					c.now = func() time.Time { return c.selection.ExpiresAt }
				case "epoch":
					c.connection.epoch.Add(1)
				}
				return nil
			})
			if err != nil || r.State != task.Uncertain || r.Reference != ref {
				t.Fatalf("uncertain: %+v %v ref %+v", r, err, ref)
			}
			if mode == "lost-ack" || mode == "same-turn-ack" || mode == "invalid-turn-ack" {
				if calls != 0 {
					t.Fatal("invented ACK lineage")
				}
			} else if calls != 1 || ref != followupRef() {
				t.Fatal("lost known ACK lineage")
			}
			// Restore only the source clock/check to exercise the sticky local fence.
			c.now = func() time.Time { return c.selection.GrantedAt.Add(time.Minute) }
			c.recheck = func(context.Context, task.Binding) error { return nil }
			f.valid.Store(true)
			for _, id := range []string{"uncertain-followup", "other-followup"} {
				again, _ := c.Continue(context.Background(), followupDispatch(c.selection, id), func(task.Reference) error { t.Fatal("replay callback"); return nil })
				if again.State != task.Uncertain {
					t.Fatal(again)
				}
			}
			created, _ := c.Create(context.Background(), dispatch(c.selection, "create-after-unknown"), func(task.Reference) error { t.Fatal("late create"); return nil })
			if created.State != task.Uncertain || f.launches.Load() != 1 || len(f.seen("turn/start")) != 1 || len(f.seen("thread/start")) != 0 {
				t.Fatal("unknown fence bypassed")
			}
			if _, err := c.Supports(context.Background(), c.selection.Binding); !errors.Is(err, task.ErrUnknown) {
				t.Fatal("unknown capabilities resurrected")
			}
		})
	}
}

func TestSourceOnlyContinueOperationConflictAndCapacity(t *testing.T) {
	c, f := newFollowupFixture(t)
	d := followupDispatch(c.selection, "known-followup")
	r, _ := c.Continue(context.Background(), d, func(task.Reference) error { return nil })
	if r.State != task.Known {
		t.Fatal(r)
	}
	again, _ := c.Continue(context.Background(), d, func(task.Reference) error { t.Fatal("replay"); return nil })
	if again.State != task.Uncertain {
		t.Fatal(again)
	}
	d.Message = "changed"
	conflict, _ := c.Continue(context.Background(), d, func(task.Reference) error { return nil })
	if conflict.Code != "CODEX_OPERATION_CONFLICT" || conflict.State != task.Rejected {
		t.Fatal(conflict)
	}
	if len(f.seen("turn/start")) != 1 || f.launches.Load() != 1 {
		t.Fatal("effect repeated")
	}
	c, f = newFollowupFixture(t)
	for n := 0; n < maxOperations; n++ {
		c.used["retained-"+strconv.Itoa(n)] = [32]byte{}
	}
	r, _ = c.Continue(context.Background(), followupDispatch(c.selection, "capacity"), func(task.Reference) error { return nil })
	if r.Code != "CODEX_OPERATION_CAPACITY" || r.State != task.Rejected || f.launches.Load() != 0 {
		t.Fatal("capacity evicted fence or reached host")
	}
}

func TestSourceOnlyContinueFreshAdmissionCannotReplayKnownOperation(t *testing.T) {
	c, f := newFollowupFixture(t)
	d := followupDispatch(c.selection, "old-operation")
	r, _ := c.Continue(context.Background(), d, func(task.Reference) error { return nil })
	if r.State != task.Known {
		t.Fatal(r)
	}
	d.Intent.Admission.TaskEpoch++
	d.Intent.Admission.TurnID = "another-farol-turn"
	r, _ = c.Continue(context.Background(), d, func(task.Reference) error { t.Fatal("old operation replayed"); return nil })
	if r.State != task.Rejected || r.Code != "CODEX_OPERATION_CONFLICT" || len(f.seen("turn/start")) != 1 {
		t.Fatal(r)
	}
}

func TestSourceOnlyContinueReadOnlyPolicyAndTerminalNewTurn(t *testing.T) {
	s := testSelection()
	s.Sandbox = "read-only"
	f := &pipeFixture{selection: s}
	f.valid.Store(true)
	c, err := New(Options{Selection: s, Followup: followupQualification(s), Boundary: f, Now: func() time.Time { return s.GrantedAt.Add(time.Minute) }, Recheck: func(context.Context, task.Binding) error { return nil }, RecheckDispatch: fixtureDispatchCheck})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	f.handle = func(q fixtureRequest) (any, bool) {
		v, drop := followupResponse(f, q)
		if q.method == "thread/turns/list" && len(f.seen("turn/start")) > 0 {
			v.(map[string]any)["data"].([]any)[0].(map[string]any)["status"] = "completed"
		}
		return v, drop
	}
	r, err := c.Continue(context.Background(), followupDispatch(s, "read-only-followup"), func(task.Reference) error { return nil })
	if err != nil || r.State != task.Known || r.Reference != followupRef() {
		t.Fatalf("ACK: %+v %v", r, err)
	}
	policy, ok := object(f.seen("turn/start")[0].params, "sandboxPolicy")
	network, haveNetwork := boolean(policy, "networkAccess")
	_, haveRoots := policy["writableRoots"]
	if !ok || !equals(policy, "type", "readOnly") || !haveNetwork || network || haveRoots {
		t.Fatal("read-only policy widened")
	}
	// The start ACK is not a result/parent-delivery witness, even if a source
	// history response already reports the new turn completed.
	if r.Lifecycle != task.Running || r.Result != "" {
		t.Fatal("invented result delivery")
	}
}

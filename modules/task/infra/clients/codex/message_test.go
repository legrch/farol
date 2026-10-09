package codex

// Controlled pipe tests exercise the production producer and JSON/RPC boundary.
// They do not qualify an account, native host, installed tool or live provider.
import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func messageDispatch(s Selection, id string) port.Dispatch {
	d := followupDispatch(s, id)
	d.Intent.Action = task.Message
	d.Intent.Admission.TaskEpoch = 1
	d.Intent.Admission.TurnID = "active-farol-turn"
	return d
}

func messageResponse(f *pipeFixture, q fixtureRequest) (any, bool) {
	if q.method == "turn/steer" {
		return map[string]any{"turnId": completeRef().TurnID}, false
	}
	v, drop := f.response(q)
	if q.method == "thread/turns/list" {
		v.(map[string]any)["data"].([]any)[0].(map[string]any)["status"] = "inProgress"
	}
	return v, drop
}

func newMessageFixture(t *testing.T) (*Client, *pipeFixture) {
	t.Helper()
	c, f := newFixture(t)
	f.handle = func(q fixtureRequest) (any, bool) { return messageResponse(f, q) }
	return c, f
}

func requireNoMessageRetry(t *testing.T, c *Client, f *pipeFixture, d port.Dispatch) {
	t.Helper()
	steers, launches := len(f.seen("turn/steer")), f.launches.Load()
	for _, next := range []port.Dispatch{d, messageDispatch(c.selection, "new-after-unknown")} {
		r, err := c.Message(context.Background(), next, func(task.Reference) error { t.Error("replay callback"); return nil })
		if err != nil || r.State != task.Uncertain || r.Reference != d.Intent.Expected {
			t.Fatalf("uncertainty fence lost: %+v %v", r, err)
		}
	}
	created, _ := c.Create(context.Background(), dispatch(c.selection, "create-after-steer"), func(task.Reference) error { t.Error("new create"); return nil })
	if created.State != task.Uncertain || len(f.seen("turn/steer")) != steers || len(f.seen("turn/start")) != 0 || len(f.seen("thread/start")) != 0 || f.launches.Load() != launches {
		t.Fatal("steer uncertainty permitted another effect or connection")
	}
	if _, err := c.Supports(context.Background(), c.selection.Binding); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("uncertain capability resurrected")
	}
}

func TestSourceOnlyMessageSteersExactActiveTurn(t *testing.T) {
	c, f := newMessageFixture(t)
	before := c.selection
	d := messageDispatch(before, "message-exact")
	var checked []task.Intent
	c.dispatchRecheck = func(_ context.Context, i task.Intent) error { checked = append(checked, i); return nil }
	caps, err := c.Supports(context.Background(), before.Binding)
	if err != nil || caps != (task.Capabilities{Create: true, Message: true}) || len(checked) != 0 {
		t.Fatalf("message capabilities: %+v %v", caps, err)
	}
	var refs []task.Reference
	r, err := c.Dispatch(context.Background(), d, func(ref task.Reference) error { refs = append(refs, ref); return nil })
	if err != nil || r.State != task.Known || r.Reference != completeRef() || r.Lifecycle != task.Running || r.Result != "" || !reflect.DeepEqual(refs, []task.Reference{completeRef()}) {
		t.Fatalf("steer ACK: %+v %v refs %+v", r, err, refs)
	}
	if !reflect.DeepEqual(checked, []task.Intent{d.Intent}) || c.selection != before || len(f.seen("turn/steer")) != 1 || len(f.seen("turn/start")) != 0 || len(f.seen("thread/start")) != 0 || f.launches.Load() != 1 {
		t.Fatal("wrong owner, selection, effect or connection")
	}
	p := f.seen("turn/steer")[0].params
	input, ok := array(p, "input", 1)
	if len(p) != 3 || !equals(p, "threadId", d.Intent.Expected.ThreadID) || !equals(p, "expectedTurnId", d.Intent.Expected.TurnID) || !ok || len(input) != 1 {
		t.Fatal("steer did not carry exact vendor precondition")
	}
	text, err := parse(input[0])
	if err != nil || len(text) != 2 || !equals(text, "type", "text") || !equals(text, "text", d.Message) {
		t.Fatal("message changed or additional input authority sent")
	}
	if len(f.seen("thread/items/list")) != 0 {
		t.Fatal("steer read transcript/result")
	}
}

func TestSourceOnlyMessageRejectsBeforeEffect(t *testing.T) {
	for _, mode := range []string{"wrong-action", "no-admission", "wrong-task", "no-parent-turn", "wrong-binding", "incomplete", "vendor-id", "empty", "whitespace", "large", "nul", "invalid-utf8", "no-progress", "thread", "project", "writer", "model", "missing", "completed", "failed", "interrupted", "unknown-status", "another-active", "two-active", "duplicate-turn", "bad-cursor", "cycle", "grant", "physical", "expired"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newMessageFixture(t)
			d := messageDispatch(c.selection, "reject-steer")
			progress := func(task.Reference) error { t.Error("unstarted lineage"); return nil }
			switch mode {
			case "wrong-action":
				d.Intent.Action = task.Continue
			case "no-admission":
				d.Intent.Admission = task.AdmissionBinding{}
			case "wrong-task":
				d.Intent.Admission.TaskID = "another-task"
			case "no-parent-turn":
				d.Intent.Parent.TurnID = ""
			case "wrong-binding":
				d.Intent.Binding.HostID = "another-host"
			case "incomplete":
				d.Intent.Expected.TurnID = ""
			case "vendor-id":
				d.Intent.Expected.TurnID = "invalid/id"
			case "empty":
				d.Message = ""
			case "whitespace":
				d.Message = " \n "
			case "large":
				d.Message = strings.Repeat("x", 8193)
			case "nul":
				d.Message = "a\x00b"
			case "invalid-utf8":
				d.Message = string([]byte{0xff})
			case "no-progress":
				progress = nil
			case "physical":
				f.valid.Store(false)
			case "grant":
				c.recheck = func(context.Context, task.Binding) error { return task.ErrIdentity }
			case "expired":
				c.now = func() time.Time { return c.selection.ExpiresAt }
			}
			pages := 0
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := messageResponse(f, q)
				m, _ := v.(map[string]any)
				if q.method == "thread/read" {
					thread := m["thread"].(map[string]any)
					switch mode {
					case "thread":
						thread["id"] = "another-thread"
					case "project":
						thread["projectId"] = "another-project"
					case "writer":
						thread["cwd"] = "/other/writer"
					case "model":
						thread["model"] = "another-model"
					}
				}
				if q.method == "thread/turns/list" {
					pages++
					row := m["data"].([]any)[0].(map[string]any)
					switch mode {
					case "missing":
						m["data"] = []any{}
					case "completed", "failed", "interrupted":
						row["status"] = mode
					case "unknown-status":
						row["status"] = "queued"
					case "another-active":
						row["id"] = "another-turn"
					case "two-active":
						m["data"] = append(m["data"].([]any), map[string]any{"id": "another-turn", "status": "inProgress"})
					case "duplicate-turn":
						m["data"] = append(m["data"].([]any), row)
					case "bad-cursor":
						m["nextCursor"] = 1
					case "cycle":
						row["id"] = "older-" + strconv.Itoa(pages)
						m["nextCursor"] = "repeat"
					}
				}
				return v, drop
			}
			r, err := c.Message(context.Background(), d, progress)
			if err != nil || r.State != task.Rejected || len(f.seen("turn/steer")) != 0 || len(f.seen("turn/start")) != 0 || len(f.seen("thread/start")) != 0 {
				t.Fatalf("unqualified steer: %+v %v", r, err)
			}
		})
	}
}

func TestSourceOnlyMessageUncertaintyRetainsTargetAndFences(t *testing.T) {
	for _, mode := range []string{"lost-ack", "crossed-ack", "invalid-ack", "missing-ack", "null-ack", "numeric-ack", "duplicate-key", "rpc-id", "callback", "panic", "grant", "physical", "expiry", "epoch", "close"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newMessageFixture(t)
			d := messageDispatch(c.selection, "uncertain-steer")
			if mode == "rpc-id" {
				f.badID = "turn/steer"
			}
			f.handle = func(q fixtureRequest) (any, bool) {
				if q.method == "turn/steer" {
					switch mode {
					case "lost-ack":
						return nil, true
					case "crossed-ack":
						return map[string]any{"turnId": "another-turn"}, false
					case "invalid-ack":
						return map[string]any{"turnId": "invalid/id"}, false
					case "missing-ack":
						return map[string]any{}, false
					case "null-ack":
						return map[string]any{"turnId": nil}, false
					case "numeric-ack":
						return map[string]any{"turnId": 1}, false
					case "duplicate-key":
						return json.RawMessage(`{"turnId":"turn-exact","turnId":"another"}`), false
					}
				}
				return messageResponse(f, q)
			}
			calls := 0
			r, err := c.Message(context.Background(), d, func(ref task.Reference) error {
				calls++
				if ref != completeRef() {
					t.Error("reference retargeted")
				}
				switch mode {
				case "callback":
					return task.ErrUnknown
				case "panic":
					panic("controlled persistence failure")
				case "grant":
					c.recheck = func(context.Context, task.Binding) error { return task.ErrIdentity }
				case "physical":
					f.valid.Store(false)
				case "expiry":
					c.now = func() time.Time { return c.selection.ExpiresAt }
				case "epoch":
					c.connection.epoch.Add(1)
				case "close":
					_ = c.Close(context.Background())
				}
				return nil
			})
			if err != nil || r.State != task.Uncertain || r.Reference != completeRef() || r.Result != "" || len(f.seen("turn/steer")) != 1 {
				t.Fatalf("uncertain steer: %+v %v", r, err)
			}
			want := 0
			switch mode {
			case "callback", "panic", "grant", "physical", "expiry", "epoch", "close":
				want = 1
			}
			if calls != want {
				t.Fatalf("progress callbacks %d want %d", calls, want)
			}
			if mode == "close" {
				return
			} // Closed lifetime can only refuse; it cannot replay.
			c.now = func() time.Time { return c.selection.GrantedAt.Add(time.Minute) }
			c.recheck = func(context.Context, task.Binding) error { return nil }
			f.valid.Store(true)
			requireNoMessageRetry(t, c, f, d)
		})
	}
}

func TestSourceOnlyMessageOperationFenceAndBounds(t *testing.T) {
	c, f := newMessageFixture(t)
	d := messageDispatch(c.selection, "message-fence")
	d.Message = strings.Repeat("x", 8192)
	r, err := c.Message(context.Background(), d, func(task.Reference) error { return nil })
	if err != nil || r.State != task.Known {
		t.Fatal(r, err)
	}
	r, _ = c.Message(context.Background(), d, func(task.Reference) error { t.Error("duplicate callback"); return nil })
	if r.State != task.Uncertain {
		t.Fatal(r)
	}
	d.Message = "changed"
	r, _ = c.Message(context.Background(), d, func(task.Reference) error { return nil })
	if r.State != task.Rejected || r.Code != "CODEX_OPERATION_CONFLICT" || len(f.seen("turn/steer")) != 1 || f.launches.Load() != 1 {
		t.Fatal(r)
	}
	c, f = newMessageFixture(t)
	for n := 0; n < maxOperations; n++ {
		c.used["retained-"+strconv.Itoa(n)] = [32]byte{}
	}
	r, _ = c.Message(context.Background(), messageDispatch(c.selection, "capacity"), func(task.Reference) error { return nil })
	if r.State != task.Rejected || r.Code != "CODEX_OPERATION_CAPACITY" || f.launches.Load() != 0 {
		t.Fatal("operation fence evicted or host reached", r)
	}
}

func completionNotice(peer net.Conn, c *Client, ref task.Reference) error {
	raw, err := json.Marshal(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": ref.ThreadID, "turn": map[string]any{"id": ref.TurnID, "status": "completed"}}})
	if err != nil {
		return err
	}
	if err := fixtureSend(peer, 1, raw); err != nil {
		return err
	}
	deadline := time.Now().Add(time.Second)
	for {
		witness := c.steer.Load()
		if witness != nil && witness.closed.Load() {
			return nil
		}
		if c.connection.lost.Load() || time.Now().After(deadline) {
			return fmt.Errorf("exact completion notice was not consumed")
		}
		runtime.Gosched()
	}
}

func TestSourceOnlyMessagePreWriteGuardAndCompletion(t *testing.T) {
	for _, mode := range []string{"refuse", "panic", "cancel-error", "cancel-nil", "close", "account-updated", "account-login", "completion"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newMessageFixture(t)
			ready := make(chan net.Conn, 1)
			var captured sync.Once
			f.beforeReply = func(_ fixtureRequest, peer net.Conn, _ *bufio.Reader) error {
				captured.Do(func() { ready <- peer })
				return nil
			}
			if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
				t.Fatal(err)
			}
			peer := <-ready
			d := messageDispatch(c.selection, "guard-steer")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var checks atomic.Int32
			c.dispatchRecheck = func(_ context.Context, got task.Intent) error {
				checks.Add(1)
				if !reflect.DeepEqual(got, d.Intent) {
					t.Error("crossed owner intent")
					return task.ErrIdentity
				}
				switch mode {
				case "refuse":
					return task.ErrIdentity
				case "panic":
					panic("controlled owner refusal")
				case "cancel-error":
					cancel()
					return task.ErrIdentity
				case "cancel-nil":
					cancel()
				case "close":
					_ = c.Close(context.Background())
				case "account-updated":
					return epochNotice(peer, c.connection, "account/updated")
				case "account-login":
					return epochNotice(peer, c.connection, "account/login/completed")
				case "completion":
					return completionNotice(peer, c, completeRef())
				}
				return nil
			}
			r, err := c.Message(ctx, d, func(task.Reference) error { t.Error("unwritten lineage"); return nil })
			if err != nil || r.State != task.Uncertain || r.Reference != completeRef() || checks.Load() != 1 || len(f.seen("turn/steer")) != 0 || f.launches.Load() != 1 {
				t.Fatalf("prewrite guard leaked effects: %+v %v checks=%d", r, err, checks.Load())
			}
			if mode != "close" {
				requireNoMessageRetry(t, c, f, d)
			}
		})
	}
}

func TestSourceOnlyMessageInvalidationWhileWriteLockQueued(t *testing.T) {
	for _, mode := range []string{"revoke", "account-updated", "account-login", "completion", "cancel", "close"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newMessageFixture(t)
			if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
				t.Fatal(err)
			}
			original := c.connection
			var revoked atomic.Bool
			var checks atomic.Int32
			c.dispatchRecheck = func(context.Context, task.Intent) error {
				checks.Add(1)
				if revoked.Load() {
					return task.ErrIdentity
				}
				return nil
			}
			type heldWrite struct {
				peer  net.Conn
				prior uint64
			}
			locked := make(chan heldWrite, 1)
			var armed atomic.Bool
			f.beforeReply = func(q fixtureRequest, peer net.Conn, _ *bufio.Reader) error {
				if q.method == "thread/turns/list" && armed.CompareAndSwap(false, true) {
					var prior uint64
					if err := json.Unmarshal(q.id, &prior); err != nil {
						return err
					}
					original.ws.writes.Lock()
					locked <- heldWrite{peer, prior}
				}
				return nil
			}
			d := messageDispatch(c.selection, "queued-steer")
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			type answer struct {
				receipt task.Receipt
				err     error
			}
			done := make(chan answer, 1)
			go func() {
				r, err := c.Message(ctx, d, func(task.Reference) error { t.Error("queued lineage"); return nil })
				done <- answer{r, err}
			}()
			var held heldWrite
			select {
			case held = <-locked:
			case <-time.After(time.Second):
				t.Fatal("history did not hold write lock")
			}
			var once sync.Once
			release := func() { once.Do(func() { original.ws.writes.Unlock() }) }
			defer release()
			deadline := time.Now().Add(time.Second)
			for {
				original.mu.Lock()
				queued := original.pending != nil && original.pendingID > held.prior
				original.mu.Unlock()
				if queued {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("steer did not reach write-lock queue")
				}
				runtime.Gosched()
			}
			if checks.Load() != 0 {
				t.Fatal("owner checked before write lock")
			}
			switch mode {
			case "revoke":
				revoked.Store(true)
			case "account-updated":
				if err := epochNotice(held.peer, original, "account/updated"); err != nil {
					t.Fatal(err)
				}
			case "account-login":
				if err := epochNotice(held.peer, original, "account/login/completed"); err != nil {
					t.Fatal(err)
				}
			case "completion":
				if err := completionNotice(held.peer, c, completeRef()); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				cancel()
			case "close":
				_ = c.Close(context.Background())
			}
			release()
			var out answer
			select {
			case out = <-done:
			case <-time.After(time.Second):
				t.Fatal("queued steer did not finish")
			}
			if out.err != nil || out.receipt.State != task.Uncertain || out.receipt.Reference != completeRef() || len(f.seen("turn/steer")) != 0 || c.connection != original || f.launches.Load() != 1 {
				t.Fatalf("queued invalidation permitted steer/reconnect: %+v %v", out.receipt, out.err)
			}
			if mode != "close" {
				requireNoMessageRetry(t, c, f, d)
			}
		})
	}
}

func TestSourceOnlyMessageCompletionAfterACKIsNotRollbackOrResult(t *testing.T) {
	c, f := newMessageFixture(t)
	ready := make(chan net.Conn, 1)
	var captured sync.Once
	f.beforeReply = func(_ fixtureRequest, peer net.Conn, _ *bufio.Reader) error {
		captured.Do(func() { ready <- peer })
		return nil
	}
	if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
		t.Fatal(err)
	}
	peer := <-ready
	r, err := c.Message(context.Background(), messageDispatch(c.selection, "completed-after-ack"), func(ref task.Reference) error { return completionNotice(peer, c, ref) })
	if err != nil || r.State != task.Known || r.Lifecycle != task.Running || r.Reference != completeRef() || r.Result != "" || len(f.seen("turn/steer")) != 1 || c.steer.Load() != nil {
		t.Fatalf("accepted steer invented terminal proof/rollback: %+v %v", r, err)
	}
}

func TestSourceOnlyMessageKeepsOriginalObservedDispatch(t *testing.T) {
	c, f := newMessageFixture(t)
	var events []task.ExecutionEvent
	created, err := c.DispatchObserved(context.Background(), dispatch(c.selection, "original-create"), func(task.Reference) error { return nil }, func(_ context.Context, e task.ExecutionEvent) error { events = append(events, e); return nil })
	if err != nil || created.State != task.Known {
		t.Fatal(created, err)
	}
	original := c.events
	steered, err := c.DispatchObserved(context.Background(), messageDispatch(c.selection, "observed-steer"), func(task.Reference) error { return nil }, func(context.Context, task.ExecutionEvent) error {
		t.Error("steer replaced original event owner")
		return nil
	})
	if err != nil || steered.State != task.Known || c.events != original {
		t.Fatal("message replaced original dispatch event sink", steered, err)
	}
	raw, _ := json.Marshal(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": completeRef().ThreadID, "turn": map[string]any{"id": completeRef().TurnID, "status": "completed"}}})
	m, _ := parse(raw)
	if err := c.notification(m); err != nil || len(events) != 1 || events[0].DispatchID != "original-create" {
		t.Fatal("original event stream lost", events, err)
	}
	if len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 || len(f.seen("turn/steer")) != 1 {
		t.Fatal("wrong observed effect counts")
	}
}

func TestSourceOnlyMessageRequiresOriginalHookWithoutQualification(t *testing.T) {
	c, f := newMessageFixture(t)
	c.dispatchRecheck = nil
	r, err := c.Message(context.Background(), messageDispatch(c.selection, "missing-hook"), func(task.Reference) error { t.Error("missing hook published lineage"); return nil })
	if err != nil || r.State != task.Uncertain || r.Reference != completeRef() || f.launches.Load() != 0 || f.checks.Load() != 0 {
		t.Fatal("missing owner hook reached host", r, err)
	}
	requireNoMessageRetry(t, c, f, messageDispatch(c.selection, "missing-hook"))
}

func TestSourceOnlyMessageHistoryIsBoundedAndUniqueAcrossPages(t *testing.T) {
	for _, mode := range []string{"valid-pages", "duplicate-across-pages", "page-cap", "missing-cursor", "oversized-page", "invalid-row"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newMessageFixture(t)
			pages := 0
			f.handle = func(q fixtureRequest) (any, bool) {
				if q.method != "thread/turns/list" {
					return messageResponse(f, q)
				}
				pages++
				id, status := "older-"+strconv.Itoa(pages), "completed"
				var nextCursor any = "page-" + strconv.Itoa(pages)
				if pages == 2 && mode != "page-cap" {
					id, status, nextCursor = completeRef().TurnID, "inProgress", nil
				}
				if mode == "duplicate-across-pages" {
					id = completeRef().TurnID
				}
				rows := []any{map[string]any{"id": id, "status": status}}
				m := map[string]any{"data": rows, "nextCursor": nextCursor}
				switch mode {
				case "missing-cursor":
					delete(m, "nextCursor")
				case "oversized-page":
					for len(rows) <= pageSize {
						rows = append(rows, map[string]any{"id": "item-" + strconv.Itoa(len(rows)), "status": "completed"})
					}
					m["data"] = rows
				case "invalid-row":
					m["data"] = []any{1}
				}
				return m, false
			}
			r, err := c.Message(context.Background(), messageDispatch(c.selection, "history-bounds"), func(task.Reference) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if mode == "valid-pages" {
				if r.State != task.Known || pages != 2 || len(f.seen("turn/steer")) != 1 {
					t.Fatal("valid bounded history rejected", r, pages)
				}
			} else if r.State != task.Rejected || len(f.seen("turn/steer")) != 0 || pages > maxPages {
				t.Fatal("unbounded/ambiguous history reached steer", r, pages)
			}
			if mode == "page-cap" && pages != maxPages {
				t.Fatal("page bound was not exercised", pages)
			}
			for _, q := range f.seen("thread/turns/list") {
				if !equals(q.params, "threadId", completeRef().ThreadID) || !equals(q.params, "itemsView", "notLoaded") || string(q.params["limit"]) != strconv.Itoa(pageSize) {
					t.Fatal("wrong history witness request")
				}
			}
		})
	}
}

func TestSourceOnlyMessageUnrelatedCompletionCannotRetarget(t *testing.T) {
	for _, ref := range []task.Reference{{ThreadID: "other-thread", TurnID: "turn-exact"}, {ThreadID: "thread-exact", TurnID: "other-turn"}} {
		t.Run(ref.ThreadID+"/"+ref.TurnID, func(t *testing.T) {
			c, f := newMessageFixture(t)
			f.beforeReply = func(q fixtureRequest, peer net.Conn, _ *bufio.Reader) error {
				if q.method != "thread/turns/list" {
					return nil
				}
				raw, _ := json.Marshal(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": ref.ThreadID, "turn": map[string]any{"id": ref.TurnID, "status": "completed"}}})
				return fixtureSend(peer, 1, raw)
			}
			r, err := c.Message(context.Background(), messageDispatch(c.selection, "unrelated-completion"), func(task.Reference) error { return nil })
			if err != nil || r.State != task.Known || r.Reference != completeRef() || len(f.seen("turn/steer")) != 1 {
				t.Fatal("unrelated completion changed selected turn", r, err)
			}
		})
	}
}

func TestSourceOnlyMessageCannotBypassMutationWriteGuard(t *testing.T) {
	c, f := newMessageFixture(t)
	if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
		t.Fatal(err)
	}
	_, err := c.connection.request(context.Background(), "turn/steer", map[string]any{"threadId": completeRef().ThreadID, "expectedTurnId": completeRef().TurnID, "input": []any{}})
	if !errors.Is(err, task.ErrUnsupported) || len(f.seen("turn/steer")) != 0 {
		t.Fatal("unguarded raw steer permitted", err)
	}
}

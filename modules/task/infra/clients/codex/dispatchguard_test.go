package codex

// CPU-only net.Pipe policy vectors; no native/provider qualification.
import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"reflect"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func newGuardFixture(t *testing.T, followup bool, check func(context.Context, task.Intent) error) (*Client, *pipeFixture, Options) {
	t.Helper()
	s := testSelection()
	f := &pipeFixture{selection: s}
	f.valid.Store(true)
	o := Options{Selection: s, Boundary: f, Now: func() time.Time { return s.GrantedAt.Add(time.Minute) }, Recheck: func(context.Context, task.Binding) error { return nil }, RecheckDispatch: check}
	if followup {
		o.Followup = followupQualification(s)
		f.handle = func(q fixtureRequest) (any, bool) { return followupResponse(f, q) }
	}
	c, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c, f, o
}
func guardDispatch(c *Client, followup bool, id string) port.Dispatch {
	if followup {
		return followupDispatch(c.selection, id)
	}
	return dispatch(c.selection, id)
}
func guardInvoke(c *Client, ctx context.Context, observed bool, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	if observed {
		return c.DispatchObserved(ctx, d, progress, func(context.Context, task.ExecutionEvent) error { return nil })
	}
	return c.Dispatch(ctx, d, progress)
}
func requireGuardNoRetry(t *testing.T, c *Client, f *pipeFixture, followup, observed bool, original port.Dispatch) {
	t.Helper()
	threads, turns, launches := len(f.seen("thread/start")), len(f.seen("turn/start")), f.launches.Load()
	for _, d := range []port.Dispatch{original, guardDispatch(c, followup, "different-operation")} {
		r, err := guardInvoke(c, context.Background(), observed, d, func(task.Reference) error { return nil })
		if err != nil || r.State != task.Uncertain || len(f.seen("thread/start")) != threads || len(f.seen("turn/start")) != turns || f.launches.Load() != launches {
			t.Fatal("guard refusal became another effect/connection", r, err)
		}
	}
}

func TestDispatchGuardQualificationWithdrawal(t *testing.T) {
	for _, followup := range []bool{false, true} {
		for _, observed := range []bool{false, true} {
			windows := []string{"model/list", "project/list"}
			if followup {
				windows = append(windows, "thread/read", "thread/turns/list")
			} else {
				windows = append(windows, "between-starts")
			}
			for _, window := range windows {
				t.Run(testGuardName(followup, observed)+"/"+window, func(t *testing.T) {
					var withdrawn atomic.Bool
					var checked atomic.Int32
					var expected task.Intent
					c, f, _ := newGuardFixture(t, followup, func(_ context.Context, got task.Intent) error {
						checked.Add(1)
						if !reflect.DeepEqual(got, expected) {
							return task.ErrIdentity
						}
						if withdrawn.Load() {
							return task.ErrState
						}
						return nil
					})
					// Supports has no dispatch intent. It may check the presence of the
					// immutable hook, but must not invoke it or invent an intention.
					if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
						t.Fatal(err)
					}
					if checked.Load() != 0 {
						t.Fatal("Supports fabricated dispatch authority")
					}
					f.handle = func(q fixtureRequest) (any, bool) {
						if q.method == window {
							withdrawn.Store(true)
						}
						if followup {
							return followupResponse(f, q)
						}
						return f.response(q)
					}
					d := guardDispatch(c, followup, "parent-window")
					expected = d.Intent
					var refs []task.Reference
					r, err := guardInvoke(c, context.Background(), observed, d, func(ref task.Reference) error {
						refs = append(refs, ref)
						if window == "between-starts" {
							withdrawn.Store(true)
						}
						return nil
					})
					wantThreads := 0
					if window == "between-starts" {
						wantThreads = 1
					}
					if err != nil || r.State != task.Uncertain || len(f.seen("thread/start")) != wantThreads || len(f.seen("turn/start")) != 0 || checked.Load() == 0 {
						t.Fatalf("withdrawal %s leaked Send: receipt=%+v err=%v thread=%d turn=%d checks=%d", window, r, err, len(f.seen("thread/start")), len(f.seen("turn/start")), checked.Load())
					}
					if wantThreads == 1 && (r.Reference != (task.Reference{ThreadID: "thread-exact"}) || !reflect.DeepEqual(refs, []task.Reference{{ThreadID: "thread-exact"}})) {
						t.Fatal("lost partial thread lineage", r, refs)
					}
					if followup && r.Reference != d.Intent.Expected {
						t.Fatal("lost exact original vendor parent", r)
					}
					requireGuardNoRetry(t, c, f, followup, observed, d)
				})
			}
		}
	}
}
func testGuardName(followup, observed bool) string {
	name := "create"
	if followup {
		name = "continue"
	}
	if observed {
		name += "/observed"
	} else {
		name += "/plain"
	}
	return name
}

func TestDispatchGuardWithdrawalWhileWriteLockHeld(t *testing.T) {
	for _, followup := range []bool{false, true} {
		for _, observed := range []bool{false, true} {
			t.Run(testGuardName(followup, observed), func(t *testing.T) {
				var withdrawn atomic.Bool
				var checks atomic.Int32
				c, f, _ := newGuardFixture(t, followup, func(context.Context, task.Intent) error {
					checks.Add(1)
					if withdrawn.Load() {
						return task.ErrState
					}
					return nil
				})
				if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
					t.Fatal(err)
				}
				locked := make(chan uint64, 1)
				var unlock sync.Once
				var ws *websocket
				window := "project/list"
				if followup {
					window = "thread/turns/list"
				}
				var armed atomic.Bool
				f.beforeReply = func(q fixtureRequest, _ net.Conn, _ *bufio.Reader) error {
					if q.method == window && armed.CompareAndSwap(false, true) {
						ws = c.connection.ws
						ws.writes.Lock()
						var id uint64
						if err := json.Unmarshal(q.id, &id); err != nil {
							return err
						}
						locked <- id
					}
					return nil
				}
				d := guardDispatch(c, followup, "lock-window")
				type answer struct {
					receipt task.Receipt
					err     error
				}
				done := make(chan answer, 1)
				callCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				go func() {
					r, err := guardInvoke(c, callCtx, observed, d, func(task.Reference) error { return nil })
					done <- answer{r, err}
				}()
				var prior uint64
				select {
				case prior = <-locked:
				case <-time.After(time.Second):
					t.Fatal("qualification did not hold write lock")
				}
				release := func() { unlock.Do(func() { ws.writes.Unlock() }) }
				defer release()
				// The next RPC is registered, and its writer is queued behind
				// the held transport mutex. No timed guess at qualification.
				deadline := time.Now().Add(time.Second)
				for {
					c.connection.mu.Lock()
					queued := c.connection.pending != nil && c.connection.pendingID > prior
					c.connection.mu.Unlock()
					if queued {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("mutation did not reach send queue")
					}
					runtime.Gosched()
				}
				if checks.Load() != 0 {
					t.Fatal("dispatch hook ran before send-lock acquisition")
				}
				withdrawn.Store(true)
				release()
				var out answer
				select {
				case out = <-done:
				case <-time.After(time.Second):
					t.Fatal("guarded send did not finish")
				}
				if out.err != nil || out.receipt.State != task.Uncertain || len(f.seen("thread/start")) != 0 || len(f.seen("turn/start")) != 0 || checks.Load() != 1 {
					t.Fatal("parent withdrawal while queued leaked physical write", out, checks.Load())
				}
				requireGuardNoRetry(t, c, f, followup, observed, d)
			})
		}
	}
}

func TestDispatchGuardErrorAndCancellation(t *testing.T) {
	for _, followup := range []bool{false, true} {
		for _, mode := range []string{"error", "panic", "cancel-error", "cancel-nil"} {
			t.Run(testGuardName(followup, false)+"/"+mode, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				c, f, _ := newGuardFixture(t, followup, func(context.Context, task.Intent) error {
					if mode == "error" {
						return errors.New("private guard diagnostic")
					}
					if mode == "panic" {
						panic("private guard panic")
					}
					cancel()
					if mode == "cancel-error" {
						return context.Canceled
					}
					return nil
				})
				d := guardDispatch(c, followup, "refused-guard")
				r, err := c.Dispatch(ctx, d, func(task.Reference) error { return nil })
				if err != nil || r.State != task.Uncertain || len(f.seen("thread/start")) != 0 || len(f.seen("turn/start")) != 0 {
					t.Fatal("guard error/cancel reached first Send", r, err)
				}
				requireGuardNoRetry(t, c, f, followup, false, d)
			})
		}
	}
}
func TestDispatchGuardMissingKeepsOnlyReads(t *testing.T) {
	for _, followup := range []bool{false, true} {
		t.Run(testGuardName(followup, false), func(t *testing.T) {
			c, f, _ := newGuardFixture(t, followup, nil)
			caps, err := c.Supports(context.Background(), c.selection.Binding)
			if !errors.Is(err, task.ErrUnsupported) || caps != (task.Capabilities{}) || f.launches.Load() != 0 {
				t.Fatal("missing guard advertised effects", caps, err)
			}
			d := guardDispatch(c, followup, "unguarded")
			r, err := c.Dispatch(context.Background(), d, func(task.Reference) error { return nil })
			if err != nil || r.State != task.Uncertain || f.launches.Load() != 0 {
				t.Fatal("missing guard reached boundary", r, err)
			}
			requireGuardNoRetry(t, c, f, followup, false, d)
			// Follow-up's descending-prefix fixture is not an Observe page.
			// Restore the explicit retained-read page fixture for this query.
			f.handle = nil
			obs, err := c.Observe(context.Background(), c.selection.Binding, completeRef())
			if err != nil || obs.Lifecycle != task.Completed || obs.Result != "source-only final" {
				t.Fatal("read compatibility changed", obs, err)
			}
		})
	}
}
func TestDispatchGuardImmutableOptionsAndOriginalIntent(t *testing.T) {
	for _, followup := range []bool{false, true} {
		for _, observed := range []bool{false, true} {
			t.Run(testGuardName(followup, observed), func(t *testing.T) {
				var expected task.Intent
				var seen []task.Intent
				c, f, options := newGuardFixture(t, followup, func(_ context.Context, got task.Intent) error {
					seen = append(seen, got)
					if !reflect.DeepEqual(got, expected) {
						return task.ErrIdentity
					}
					return nil
				})
				options.RecheckDispatch = func(context.Context, task.Intent) error { return task.ErrState }
				_ = options
				d := guardDispatch(c, followup, "original-intent")
				expected = d.Intent
				r, err := guardInvoke(c, context.Background(), observed, d, func(task.Reference) error { return nil })
				want := 2
				if followup {
					want = 1
				}
				if err != nil || r.State != task.Known || len(seen) != want || len(f.seen("turn/start")) != 1 {
					t.Fatal("hook changed or intent lost", r, err, seen)
				}
				before := len(seen)
				if followup {
					f.handle = func(q fixtureRequest) (any, bool) {
						if q.method == "thread/turns/list" {
							return map[string]any{"data": []any{map[string]any{"id": r.Reference.TurnID, "status": "inProgress"}}, "nextCursor": nil}, false
						}
						return f.response(q)
					}
				}
				if _, err := c.Observe(context.Background(), c.selection.Binding, r.Reference); err != nil {
					t.Fatal(err)
				}
				if len(seen) != before {
					t.Fatal("historical read acquired dispatch authority")
				}
			})
		}
	}
}

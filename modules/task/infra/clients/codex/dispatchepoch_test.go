package codex

// CPU-only account notifications over net.Pipe, with current Binding/Parent
// and immutable dispatch hook. No real account, host or provider is inspected.
import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/domain"
)

func epochNotice(peer net.Conn, connection *proxy, method string) error {
	before := connection.epoch.Load()
	raw, err := json.Marshal(map[string]any{"method": method, "params": map[string]any{}})
	if err != nil {
		return err
	}
	if err := fixtureSend(peer, 1, raw); err != nil {
		return err
	}
	deadline := time.Now().Add(time.Second)
	for connection.epoch.Load() == before {
		if connection.lost.Load() || time.Now().After(deadline) {
			return fmt.Errorf("CPU notification was not consumed")
		}
		runtime.Gosched()
	}
	return nil
}

func TestDispatchEpochChangesBeforePhysicalWrite(t *testing.T) {
	for _, notification := range []string{"account/updated", "account/login/completed"} {
		for _, followup := range []bool{false, true} {
			for _, observed := range []bool{false, true} {
				windows := []string{"queued-before", "hook-before"}
				if !followup {
					windows = append(windows, "queued-between", "hook-between")
				}
				for _, window := range windows {
					t.Run(notification+"/"+testGuardName(followup, observed)+"/"+window, func(t *testing.T) {
						var c *Client
						var peer net.Conn
						var hookCalls atomic.Int32
						var expected task.Intent
						between := strings.HasSuffix(window, "between")
						targetHook := int32(1)
						if between {
							targetHook = 2
						}
						var f *pipeFixture
						c, f, _ = newGuardFixture(t, followup, func(_ context.Context, got task.Intent) error {
							if !reflect.DeepEqual(got, expected) {
								return task.ErrIdentity
							}
							if hookCalls.Add(1) == targetHook && strings.HasPrefix(window, "hook") {
								// Test peer injects the notification while the simulated
								// Root hook is awaiting. There is no Chat gate or native IO.
								if err := epochNotice(peer, c.connection, notification); err != nil {
									t.Error(err)
									return task.ErrUnknown
								}
							}
							return nil // Binding and original Parent remain current.
						})
						ready := make(chan net.Conn, 1)
						var capture sync.Once
						f.beforeReply = func(_ fixtureRequest, connection net.Conn, _ *bufio.Reader) error {
							capture.Do(func() { ready <- connection })
							return nil
						}
						if _, err := c.Supports(context.Background(), c.selection.Binding); err != nil {
							t.Fatal(err)
						}
						peer = <-ready
						original := c.connection
						qualifiedEpoch := original.epoch.Load()
						d := guardDispatch(c, followup, "epoch-window")
						expected = d.Intent
						var refs []task.Reference
						locked := make(chan uint64, 1)
						var releaseOnce sync.Once
						release := func() { releaseOnce.Do(func() { original.ws.writes.Unlock() }) }
						if window == "queued-before" {
							method := "project/list"
							if followup {
								method = "thread/turns/list"
							}
							var armed atomic.Bool
							f.beforeReply = func(q fixtureRequest, _ net.Conn, _ *bufio.Reader) error {
								if q.method == method && armed.CompareAndSwap(false, true) {
									var id uint64
									if err := json.Unmarshal(q.id, &id); err != nil {
										return err
									}
									original.ws.writes.Lock()
									locked <- id
								}
								return nil
							}
						}
						progress := func(ref task.Reference) error {
							refs = append(refs, ref)
							if window == "queued-between" {
								original.ws.writes.Lock()
								original.mu.Lock()
								prior := original.nextID - 1
								original.mu.Unlock()
								locked <- prior
							}
							return nil
						}
						type answer struct {
							receipt task.Receipt
							err     error
						}
						done := make(chan answer, 1)
						callCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
						defer cancel()
						go func() { r, err := guardInvoke(c, callCtx, observed, d, progress); done <- answer{r, err} }()
						if strings.HasPrefix(window, "queued") {
							var prior uint64
							select {
							case prior = <-locked:
							case <-time.After(time.Second):
								t.Fatal("mutation did not hold send lock")
							}
							defer release()
							deadline := time.Now().Add(time.Second)
							for {
								original.mu.Lock()
								queued := original.pending != nil && original.pendingID > prior
								original.mu.Unlock()
								if queued {
									break
								}
								if time.Now().After(deadline) {
									t.Fatal("mutation was not queued behind send lock")
								}
								runtime.Gosched()
							}
							if err := epochNotice(peer, original, notification); err != nil {
								t.Fatal(err)
							}
							release()
						}
						var out answer
						select {
						case out = <-done:
						case <-time.After(2 * time.Second):
							t.Fatal("mutation did not finish")
						}
						wantThreads := 0
						wantRef := task.Reference{}
						if between {
							wantThreads = 1
							wantRef.ThreadID = "thread-exact"
						}
						if followup {
							wantRef = d.Intent.Expected
						}
						if out.err != nil || out.receipt.State != task.Uncertain || len(f.seen("thread/start")) != wantThreads || len(f.seen("turn/start")) != 0 {
							t.Fatalf("new Send followed %s in %s: thread=%d turn=%d receipt=%+v err=%v", notification, window, len(f.seen("thread/start")), len(f.seen("turn/start")), out.receipt, out.err)
						}
						if out.receipt.Reference != wantRef {
							t.Fatal("wrong retained lineage", out.receipt, wantRef)
						}
						if between && !reflect.DeepEqual(refs, []task.Reference{{ThreadID: "thread-exact"}}) {
							t.Fatal("partial lineage was lost or new turn published", refs)
						}
						if !between && len(refs) != 0 {
							t.Fatal("unstarted operation published lineage", refs)
						}
						if c.connection != original || original.epoch.Load() != qualifiedEpoch+1 || f.launches.Load() != 1 {
							t.Fatal("epoch drift replaced or requalified the connection")
						}
						requireGuardNoRetry(t, c, f, followup, observed, d)
					})
				}
			}
		}
	}
}

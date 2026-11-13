package exchange

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newQueue(t *testing.T, limit int) (*Queue[string], context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	q, err := New[string](ctx, limit)
	if err != nil {
		t.Fatal(err)
	}
	return q, cancel
}

func soon(d time.Duration) time.Time { return time.Now().Add(d) }

func submit(t *testing.T, q *Queue[string], ctx context.Context, id string) *Call[string] {
	t.Helper()
	call, err := q.Submit(ctx, soon(5*time.Second), Command{ID: id, Kind: "kind", Body: json.RawMessage(`{"id":"` + id + `"}`)})
	if err != nil {
		t.Fatal(err)
	}
	return call
}

func poll(t *testing.T, q *Queue[string]) *Command {
	t.Helper()
	command, err := q.Next(context.Background(), soon(time.Second))
	if err != nil || command == nil {
		t.Fatalf("missing command: %v", err)
	}
	return command
}

func echo(value string) func(Command) (string, error) {
	return func(Command) (string, error) { return value, nil }
}

func TestNewRefusesInvalidLifetimeAndBound(t *testing.T) {
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	for name, run := range map[string]func() (*Queue[string], error){
		"nil":     func() (*Queue[string], error) { return New[string](nil, 1) }, //nolint:staticcheck // nil is the refused input
		"ended":   func() (*Queue[string], error) { return New[string](ended, 1) },
		"no-slot": func() (*Queue[string], error) { return New[string](context.Background(), 0) },
	} {
		if q, err := run(); q != nil || !errors.Is(err, ErrUnavailable) {
			t.Fatal(name, "admitted", err)
		}
	}
}

func TestDeadlineAcceptsOnlyTheBoundedFuture(t *testing.T) {
	for _, millis := range []uint64{0, 1, uint64(time.Now().UnixMilli()), uint64(soon(MaxWait + time.Second).UnixMilli()), maxMillis + 1, math.MaxInt64, math.MaxUint64} {
		if _, err := Deadline(millis); !errors.Is(err, ErrDeadline) {
			t.Fatal("admitted", millis)
		}
	}
	want := soon(time.Second).UnixMilli()
	got, err := Deadline(uint64(want))
	if err != nil || got.UnixMilli() != want {
		t.Fatal("bounded deadline refused", err)
	}
}

func TestRoundTripDeliversOnceAndAcceptsOneReply(t *testing.T) {
	q, _ := newQueue(t, 2)
	call := submit(t, q, context.Background(), "a")
	command := poll(t, q)
	if command.ID != "a" || command.Kind != "kind" || string(command.Body) != `{"id":"a"}` {
		t.Fatal("command changed", command)
	}
	command.Body[0] = 'x'
	if state := q.State(); state.Issued != 1 || state.Live != 1 || len(state.Waiting) != 0 {
		t.Fatal("delivered command still waiting", state)
	}
	if again, err := q.Next(context.Background(), soon(50*time.Millisecond)); again != nil || err != nil {
		t.Fatal("command delivered twice", again, err)
	}
	var sent Command
	if err := q.Complete("a", func(c Command) (string, error) { sent = c; return "done", nil }); err != nil {
		t.Fatal(err)
	}
	if string(sent.Body) != `{"id":"a"}` {
		t.Fatal("poll copy aliased the retained command")
	}
	if !errors.Is(q.Complete("a", echo("again")), ErrNotCurrent) {
		t.Fatal("second reply accepted")
	}
	if value, err := call.Wait(); value != "done" || err != nil {
		t.Fatal("answer lost", value, err)
	}
	call.Release()
	if !errors.Is(q.Complete("a", echo("late")), ErrNotCurrent) {
		t.Fatal("settled reply accepted")
	}
	if state := q.State(); state.Live != 0 || state.Issued != 1 {
		t.Fatal("settled call retained", state)
	}
}

func TestCompleteRefusesUndeliveredUnknownAndConsumesFailedAccept(t *testing.T) {
	q, _ := newQueue(t, 1)
	call := submit(t, q, context.Background(), "a")
	if !errors.Is(q.Complete("a", echo("early")), ErrNotCurrent) || !errors.Is(q.Complete("b", echo("foreign")), ErrNotCurrent) {
		t.Fatal("reply accepted before delivery or for a foreign ID")
	}
	poll(t, q)
	crossed := errors.New("crossed")
	if err := q.Complete("a", func(Command) (string, error) { return "", crossed }); !errors.Is(err, crossed) {
		t.Fatal("accept error lost", err)
	}
	if !errors.Is(q.Complete("a", echo("corrected")), ErrNotCurrent) {
		t.Fatal("failed reply corrected")
	}
	if _, err := call.Wait(); !errors.Is(err, crossed) {
		t.Fatal("failed reply became known", err)
	}
	call.Release()
}

func TestSubmitRefusalsAndBound(t *testing.T) {
	q, _ := newQueue(t, 2)
	first := submit(t, q, context.Background(), "a")
	if _, err := q.Submit(context.Background(), soon(time.Second), Command{ID: "a"}); !errors.Is(err, ErrDuplicate) {
		t.Fatal("live ID reissued", err)
	}
	second := submit(t, q, context.Background(), "b")
	if _, err := q.Submit(context.Background(), soon(time.Second), Command{ID: "c"}); !errors.Is(err, ErrSaturated) {
		t.Fatal("bound exceeded", err)
	}
	if _, err := q.Submit(nil, soon(time.Second), Command{ID: "c"}); !errors.Is(err, ErrUnavailable) { //nolint:staticcheck // nil is the refused input
		t.Fatal("nil context admitted", err)
	}
	if !errors.Is(q.Quiesce(), ErrNotQuiescent) {
		t.Fatal("live calls reported quiescent")
	}
	first.Release()
	second.Release()
	if err := q.Quiesce(); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Submit(context.Background(), soon(time.Second), Command{ID: "c"}); !errors.Is(err, ErrQuiesced) {
		t.Fatal("quiesced queue admitted", err)
	}
	if state := q.State(); state.Issued != 2 || !state.Quiesced {
		t.Fatal("refusals counted", state)
	}
}

func TestFenceRefusesEverything(t *testing.T) {
	q, _ := newQueue(t, 2)
	call := submit(t, q, context.Background(), "a")
	poll(t, q)
	call.Fence()
	if !errors.Is(q.Complete("a", echo("late")), ErrNotCurrent) {
		t.Fatal("fenced call completed")
	}
	if _, err := q.Submit(context.Background(), soon(time.Second), Command{ID: "b"}); !errors.Is(err, ErrFenced) {
		t.Fatal("fenced queue admitted", err)
	}
	if _, err := q.Next(context.Background(), soon(time.Second)); !errors.Is(err, ErrUnavailable) {
		t.Fatal("fenced queue polled", err)
	}
	if !errors.Is(q.Quiesce(), ErrNotQuiescent) {
		t.Fatal("fence became quiescence")
	}
	if state := q.State(); !state.Fenced || state.Live != 0 {
		t.Fatal("fence state", state)
	}
}

func TestNextRefusesEndedPollAndLifetime(t *testing.T) {
	q, cancelRoot := newQueue(t, 1)
	ended, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := q.Next(ended, soon(time.Second)); err == nil {
		t.Fatal("ended poll admitted")
	}
	if _, err := q.Next(nil, soon(time.Second)); err == nil { //nolint:staticcheck // nil is the refused input
		t.Fatal("nil poll admitted")
	}
	if command, err := q.Next(context.Background(), time.Now()); command != nil || err != nil {
		t.Fatal("expired poll was not empty", command, err)
	}
	cancelRoot()
	if _, err := q.Next(context.Background(), soon(time.Second)); err == nil {
		t.Fatal("closed lifetime polled")
	}
	if !errors.Is(q.Quiesce(), ErrNotQuiescent) {
		t.Fatal("closed lifetime became quiescence")
	}
}

func TestExpiredCallIsNeverDelivered(t *testing.T) {
	q, _ := newQueue(t, 1)
	call, err := q.Submit(context.Background(), soon(20*time.Millisecond), Command{ID: "a"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call.Wait(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expired call answered", err)
	}
	if command, err := q.Next(context.Background(), soon(50*time.Millisecond)); command != nil || err != nil {
		t.Fatal("expired call delivered", command, err)
	}
	call.Release()
}

func TestWaitEndsWithQueueLifetime(t *testing.T) {
	q, cancelRoot := newQueue(t, 1)
	call := submit(t, q, context.Background(), "a")
	poll(t, q)
	cancelRoot()
	if _, err := call.Wait(); !errors.Is(err, context.Canceled) {
		t.Fatal("closed lifetime answered", err)
	}
	call.Release()
	if !errors.Is(q.Complete("a", echo("late")), ErrNotCurrent) {
		t.Fatal("late reply accepted")
	}
}

func TestQuiesceWakesIdlePollOnce(t *testing.T) {
	q, _ := newQueue(t, 1)
	done := make(chan error, 1)
	go func() {
		command, err := q.Next(context.Background(), soon(10*time.Second))
		if command != nil {
			err = errors.New("command delivered")
		}
		done <- err
	}()
	if err := q.Quiesce(); err != nil {
		t.Fatal(err)
	}
	if err := q.Quiesce(); err != nil {
		t.Fatal("repeated quiescence", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle poll retained after quiescence")
	}
}

// Holds the queue lock so the poll's deadline or cancellation passes after
// its own validation but before the locked delivery check.
type observedPoll struct {
	context.Context
	once    sync.Once
	waiting chan struct{}
}

func (c *observedPoll) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestExpiredPollUnderLockKeepsOriginalCommand(t *testing.T) {
	for _, variant := range []string{"deadline", "cancelled"} {
		t.Run(variant, func(t *testing.T) {
			attempts := 32
			if variant == "deadline" {
				attempts = 4
			}
			for n := 0; n < attempts; n++ {
				q, _ := newQueue(t, 1)
				call := submit(t, q, context.Background(), "a")
				q.mu.Lock()
				pollCtx, cancelPoll := context.WithCancel(context.Background())
				observed := &observedPoll{Context: pollCtx, waiting: make(chan struct{})}
				until := soon(time.Second)
				if variant == "deadline" {
					until = soon(100 * time.Millisecond)
				}
				type result struct {
					command *Command
					err     error
				}
				polled := make(chan result, 1)
				go func() {
					command, err := q.Next(observed, until)
					polled <- result{command, err}
				}()
				select {
				case <-observed.waiting:
				case <-time.After(time.Second):
					q.mu.Unlock()
					cancelPoll()
					t.Fatal("poll did not start")
				}
				if variant == "deadline" {
					time.Sleep(time.Until(until) + time.Millisecond)
				} else {
					cancelPoll()
				}
				q.mu.Unlock()
				got := <-polled
				cancelPoll()
				if got.command != nil || (variant == "deadline" && got.err != nil) || (variant == "cancelled" && got.err == nil) {
					t.Fatalf("expired poll consumed the command: %+v", got)
				}
				command := poll(t, q)
				if command.ID != "a" || string(command.Body) != `{"id":"a"}` || q.State().Issued != 1 {
					t.Fatal("expired poll replaced or renewed the command")
				}
				if err := q.Complete("a", echo("ok")); err != nil {
					t.Fatal(err)
				}
				if value, err := call.Wait(); value != "ok" || err != nil {
					t.Fatal("original answer lost", value, err)
				}
				call.Release()
				if err := q.Quiesce(); err != nil {
					t.Fatal("empty poll fenced the queue", err)
				}
			}
		})
	}
}

// Several sleeping polls each receive a different command, none twice and
// none stranded until its poll deadline.
func TestSleepingPollsEachReceiveOneCommand(t *testing.T) {
	q, _ := newQueue(t, 8)
	const polls = 8
	commands := make(chan *Command, polls)
	var started sync.WaitGroup
	for n := 0; n < polls; n++ {
		started.Add(1)
		go func() {
			started.Done()
			command, err := q.Next(context.Background(), soon(5*time.Second))
			if err != nil {
				command = nil
			}
			commands <- command
		}()
	}
	started.Wait()
	time.Sleep(20 * time.Millisecond)
	calls := make([]*Call[string], polls)
	for n := range calls {
		calls[n] = submit(t, q, context.Background(), fmt.Sprint(n))
	}
	seen := map[string]bool{}
	for n := 0; n < polls; n++ {
		select {
		case command := <-commands:
			if command == nil || seen[command.ID] {
				t.Fatal("missing or repeated command", command)
			}
			seen[command.ID] = true
		case <-time.After(2 * time.Second):
			t.Fatal("sleeping poll stranded a command")
		}
	}
	for _, call := range calls {
		call.Release()
	}
}

// Calls, polls, replies, replays and expiries race. Each command is delivered
// at most once, each reply is accepted at most once and only for a delivered
// live call, and every waiter returns exactly one outcome.
func TestConcurrentPollPostExpireAndReplay(t *testing.T) {
	q, _ := newQueue(t, 8)
	const callers = 64
	var delivered, accepted, answered sync.Map
	var stop atomic.Bool
	var pollers sync.WaitGroup
	for n := 0; n < 4; n++ {
		pollers.Add(1)
		go func() {
			defer pollers.Done()
			for !stop.Load() {
				command, err := q.Next(context.Background(), soon(20*time.Millisecond))
				if err != nil {
					t.Error("poll failed", err)
					return
				}
				if command == nil {
					continue
				}
				if _, again := delivered.LoadOrStore(command.ID, true); again {
					t.Error("command delivered twice", command.ID)
				}
				// Reply twice; only the first may be accepted. accept runs only
				// for a consumed call, before its answer is sent.
				for range 2 {
					id := command.ID
					_ = q.Complete(id, func(sent Command) (string, error) {
						if sent.ID != id {
							t.Error("reply crossed", sent.ID, id)
						}
						if _, again := accepted.LoadOrStore(id, true); again {
							t.Error("reply accepted twice", id)
						}
						return id, nil
					})
				}
			}
		}()
	}
	var waiters sync.WaitGroup
	for n := 0; n < callers; n++ {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			id := fmt.Sprint("call-", n)
			// Short deadlines race delivery and replies against expiry.
			until := soon(time.Duration(n%5) * time.Millisecond)
			for {
				call, err := q.Submit(context.Background(), until, Command{ID: id, Kind: "kind"})
				if errors.Is(err, ErrSaturated) {
					time.Sleep(time.Millisecond)
					until = soon(time.Duration(n%5) * time.Millisecond)
					continue
				}
				if err != nil {
					t.Error("submit failed", err)
					return
				}
				value, err := call.Wait()
				call.Release()
				if err == nil {
					if value != id {
						t.Error("answer crossed", value, id)
					}
					if _, ok := accepted.Load(id); !ok {
						t.Error("answer without an accepted reply", id)
					}
					if _, again := answered.LoadOrStore(id, true); again {
						t.Error("answered twice", id)
					}
				}
				// A late reply after release is refused.
				if q.Complete(id, echo("late")) == nil {
					t.Error("released call accepted a reply", id)
				}
				return
			}
		}()
	}
	waiters.Wait()
	stop.Store(true)
	pollers.Wait()
	if state := q.State(); state.Live != 0 || len(state.Waiting) != 0 || state.Fenced {
		t.Fatal("queue retained settled calls", state)
	}
}

// Releasing an unknown call and fencing the queue are one step: a racing
// submit can never take the slot in between.
func TestCallFenceLeavesNoFreeSlot(t *testing.T) {
	for n := 0; n < 50; n++ {
		q, _ := newQueue(t, 1)
		call := submit(t, q, context.Background(), "unknown")
		var admitted atomic.Bool
		var stop atomic.Bool
		var racers sync.WaitGroup
		for r := 0; r < 4; r++ {
			racers.Add(1)
			go func() {
				defer racers.Done()
				for i := 0; !stop.Load(); i++ {
					next, err := q.Submit(context.Background(), soon(time.Second), Command{ID: fmt.Sprint("retry-", r, "-", i)})
					if err == nil {
						admitted.Store(true)
						next.Release()
					}
				}
			}()
		}
		time.Sleep(time.Millisecond)
		call.Fence()
		time.Sleep(time.Millisecond)
		stop.Store(true)
		racers.Wait()
		if admitted.Load() {
			t.Fatal("a retry took the slot of an unknown call")
		}
	}
}

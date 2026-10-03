package admission

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// ownerFixture supplies an injected live-owner gate over the real pure Queue.
// Its committed flag is synthetic, not durable journal or native admission proof.
// This fixture is never constructed by boot or a production provider adapter.
type ownerFixture struct {
	mu        sync.Mutex
	fixed     port.TurnBinding
	current   *port.CurrentTurn
	queue     *turn.Queue
	before    error
	after     error
	enter     func()
	callbacks int
	ignore    bool
}

func fixture(t *testing.T) (*ownerFixture, *Service) {
	t.Helper()
	fixed := port.TurnBinding{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend",
		OwnerID: "fixture-owner", SessionID: "fixture-session", TaskID: "fixture-task",
		TaskEpoch: 9, ParticipantID: "fixture-participant", TurnID: "fixture-turn",
		OperationID: "fixture-operation", TurnGeneration: 7}
	q, err := turn.NewQueue(fixed.ProfileID, fixed.BackendGeneration)
	if err != nil {
		t.Fatal(err)
	}
	view, err := q.Admit(identity(fixed), strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	owner := &ownerFixture{fixed: fixed, queue: q, callbacks: 1,
		current: &port.CurrentTurn{Binding: fixed, Turn: view, Persistence: port.Committed}}
	service, err := New(owner)
	if err != nil {
		t.Fatal(err)
	}
	return owner, service
}

func (o *ownerFixture) Binding() port.TurnBinding { return o.fixed }
func (o *ownerFixture) WithCurrent(_ context.Context, inspect func(*port.CurrentTurn) error) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.before != nil {
		return o.before
	}
	if o.enter != nil {
		o.enter()
	}
	for n := 0; n < o.callbacks; n++ {
		var view *port.CurrentTurn
		if o.current != nil {
			independent := *o.current
			view = &independent
		}
		if err := inspect(view); err != nil && !o.ignore {
			return err
		}
	}
	return o.after
}

func TestActualOwnerGateAndIndependentProjection(t *testing.T) {
	owner, service := fixture(t)
	for n := 0; n < 2; n++ {
		calls := 0
		err := service.WithCurrent(context.Background(), func(binding *TaskBinding) error {
			calls++
			if owner.mu.TryLock() {
				owner.mu.Unlock()
				t.Fatal("callback escaped owner gate")
			}
			if binding == nil || binding.OwnerID != owner.fixed.OwnerID || binding.TaskEpoch != 9 || binding.ParticipantID != "fixture-participant" {
				t.Fatal("owning admission was not preserved", binding)
			}
			binding.ParticipantID = "consumer-mutation"
			binding.TaskEpoch++
			return nil
		})
		if err != nil || calls != 1 {
			t.Fatal("callback protocol", err, calls)
		}
	}
}

func TestBodyAndProviderCorrelationCannotCreateCurrentAdmission(t *testing.T) {
	owner, service := fixture(t)
	// The static Binding remains valid, but the actual owner has no admission.
	owner.current = nil
	calls := 0
	if err := service.WithCurrent(context.Background(), func(binding *TaskBinding) error {
		calls++
		if binding != nil {
			t.Fatal("correlation became positive admission")
		}
		return nil
	}); err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	// There are no request-body or latest-task parameters in this reader API.
}

func TestPendingUnknownAndCorruptedOwnerStatesNeverExposePositive(t *testing.T) {
	tests := []struct {
		name   string
		change func(*port.CurrentTurn)
		want   Code
	}{
		{"pending journal", func(v *port.CurrentTurn) { v.Persistence = port.PendingCommit }, Unsettled},
		{"unknown journal", func(v *port.CurrentTurn) { v.Persistence = port.UnknownCommit }, Unsettled},
		{"invalid journal status", func(v *port.CurrentTurn) { v.Persistence = "cached" }, Unsettled},
		{"wrong epoch", func(v *port.CurrentTurn) { v.Binding.TaskEpoch++ }, Mismatch},
		{"wrong participant", func(v *port.CurrentTurn) { v.Binding.ParticipantID = "other-participant" }, Mismatch},
		{"wrong task", func(v *port.CurrentTurn) { v.Binding.TaskID = "other-task" }, Mismatch},
		{"wrong owner", func(v *port.CurrentTurn) { v.Binding.OwnerID = "other-owner" }, Mismatch},
		{"wrong backend", func(v *port.CurrentTurn) { v.Binding.BackendGeneration = "other-backend" }, Mismatch},
		{"wrong turn", func(v *port.CurrentTurn) { v.Turn.Identity.TurnID = "other-turn" }, Mismatch},
		{"wrong turn generation", func(v *port.CurrentTurn) { v.Turn.Identity.Generation++ }, Mismatch},
		{"unknown effect", func(v *port.CurrentTurn) { v.Turn.Phase = turn.Unknown }, Unsettled},
		{"result in active phase", func(v *port.CurrentTurn) { v.Turn.HasResult = true }, Invalid},
		{"terminal without result", func(v *port.CurrentTurn) { v.Turn.Phase = turn.Delivered }, Invalid},
		{"invalid phase", func(v *port.CurrentTurn) { v.Turn.Phase = "provider-ready" }, Invalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			owner, service := fixture(t)
			test.change(owner.current)
			calls := 0
			err := service.WithCurrent(context.Background(), func(*TaskBinding) error { calls++; return nil })
			if !errors.Is(err, test.want) || calls != 0 {
				t.Fatal("stale positive admission", err, calls)
			}
		})
	}
}

func TestCompletionAndUnknownUseExistingTurnLifecycle(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "known cancel", true: "lost send"}[unknown], func(t *testing.T) {
			owner, service := fixture(t)
			id := identity(owner.fixed)
			var view turn.Snapshot
			var err error
			if unknown {
				if _, err := owner.queue.Enqueue(id); err != nil {
					t.Fatal(err)
				}
				reservation, err := owner.queue.Reserve()
				if err != nil {
					t.Fatal(err)
				}
				prepared, err := owner.queue.Bind(reservation, turn.Document{ViewID: "fixture-view", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "fixture-conversation"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := owner.queue.Dispatch(prepared.Binding); err != nil {
					t.Fatal(err)
				}
				view, err = owner.queue.Finish(prepared.Binding, turn.Result{ID: "fixture-result", Outcome: turn.UnknownOutcome, Code: "SEND_REPLY_LOST"})
			} else {
				view, err = owner.queue.Cancel(id, "fixture-result")
			}
			if err != nil {
				t.Fatal(err)
			}
			owner.current.Turn = view
			calls := 0
			err = service.WithCurrent(context.Background(), func(binding *TaskBinding) error {
				calls++
				if binding != nil {
					t.Fatal("terminal turn retained current admission")
				}
				return nil
			})
			if unknown {
				if !errors.Is(err, Unsettled) || calls != 0 {
					t.Fatal(err, calls)
				}
			} else if err != nil || calls != 1 {
				t.Fatal(err, calls)
			}
		})
	}
}

func TestRevocationIsSerializedWithEntireCallback(t *testing.T) {
	owner, service := fixture(t)
	entered, release, readDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		readDone <- service.WithCurrent(context.Background(), func(binding *TaskBinding) error {
			if binding == nil {
				return errors.New("fixture admission absent")
			}
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	if owner.mu.TryLock() {
		owner.mu.Unlock()
		t.Fatal("completion could overtake inspection")
	}
	attempted, revoked := make(chan struct{}), make(chan struct{})
	go func() {
		close(attempted)
		owner.mu.Lock()
		owner.current = nil
		owner.mu.Unlock()
		// Any separate Computer update would happen here, outside the Chat gate.
		close(revoked)
	}()
	<-attempted
	close(release)
	if err := <-readDone; err != nil {
		t.Fatal(err)
	}
	<-revoked
	if err := service.WithCurrent(context.Background(), func(binding *TaskBinding) error {
		if binding != nil {
			t.Fatal("revoked owner retained positive admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerAndCallbackFailureProtocol(t *testing.T) {
	for _, count := range []int{0, 2} {
		owner, service := fixture(t)
		owner.callbacks = count
		calls := 0
		err := service.WithCurrent(context.Background(), func(*TaskBinding) error { calls++; return nil })
		if !errors.Is(err, Unavailable) || calls > 1 {
			t.Fatal("broken owner accepted", err, calls)
		}
	}
	owner, service := fixture(t)
	owner.before = errors.New("private fixture journal detail")
	if err := service.WithCurrent(context.Background(), func(*TaskBinding) error { t.Fatal("failed owner inspected"); return nil }); !errors.Is(err, Unavailable) {
		t.Fatal(err)
	}
	owner.before, owner.ignore = nil, true
	consumer := errors.New("consumer policy rejection")
	if err := service.WithCurrent(context.Background(), func(*TaskBinding) error { return consumer }); !errors.Is(err, consumer) {
		t.Fatal("owner swallowed consumer rejection", err)
	}
}

func TestCancelledAndInvalidReaderCannotInspect(t *testing.T) {
	_, service := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := service.WithCurrent(ctx, func(*TaskBinding) error { t.Fatal("cancelled inspect"); return nil }); !errors.Is(err, Cancelled) {
		t.Fatal(err)
	}
	if err := service.WithCurrent(context.Background(), nil); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if err := service.WithCurrent(nil, func(*TaskBinding) error { return nil }); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if s, err := New(nil); s != nil || !errors.Is(err, Unavailable) {
		t.Fatal(s, err)
	}
	owner, _ := fixture(t)
	owner.fixed.ParticipantID = ""
	if s, err := New(owner); s != nil || !errors.Is(err, Invalid) {
		t.Fatal(s, err)
	}
}

// This is an injected application projection over actual pure Queue transitions,
// not a provider/journal fixture. A result withdraws membership independently of
// browser disposal, delivery acknowledgement and eventual slot reuse.
func TestCurrentAdmissionTracksExistingLifecycleWithoutASecondEngine(t *testing.T) {
	owner, service := fixture(t)
	id := identity(owner.fixed)
	check := func(view turn.Snapshot, err error, want turn.Phase, present bool) {
		t.Helper()
		if err != nil || view.Phase != want {
			t.Fatal("queue transition", err, view.Phase, want)
		}
		owner.current.Turn = view
		calls := 0
		err = service.WithCurrent(context.Background(), func(binding *TaskBinding) error {
			calls++
			if (binding != nil) != present {
				t.Fatal("current membership", want, binding)
			}
			if binding != nil && (binding.TaskEpoch != owner.fixed.TaskEpoch || binding.ParticipantID != owner.fixed.ParticipantID) {
				t.Fatal("membership identity changed with provider lifecycle", binding)
			}
			return nil
		})
		if err != nil || calls != 1 {
			t.Fatal(err, calls)
		}
	}
	view, err := owner.queue.Enqueue(id)
	check(view, err, turn.Pending, true)
	reservation, err := owner.queue.Reserve()
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := owner.queue.Bind(reservation, turn.Document{ViewID: "fixture-view", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "fixture-conversation"})
	if err != nil {
		t.Fatal(err)
	}
	view, err = owner.queue.Dispatch(prepared.Binding)
	check(view, err, turn.Running, true)
	view, err = owner.queue.Accept(prepared.Binding)
	check(view, err, turn.Running, true)
	view, err = owner.queue.AwaitOwner(prepared.Binding)
	check(view, err, turn.AwaitingOwner, true)
	view, err = owner.queue.Resume(prepared.Binding)
	check(view, err, turn.Running, true)
	view, err = owner.queue.Delta(prepared.Binding, 1)
	check(view, err, turn.Running, true)
	view, err = owner.queue.Finish(prepared.Binding, turn.Result{ID: "fixture-result", Outcome: turn.Completed, Code: "COMPLETED"})
	check(view, err, turn.ResultReady, false)
	if view.DeliveryAcknowledged || view.LifecycleSettled {
		t.Fatal("fixture accidentally proved slot reuse")
	}
	view, err = owner.queue.Acknowledge(id, "fixture-result")
	check(view, err, turn.Delivered, false)
}

func TestEntryAndReturnCannotHideCancellationOrOwnerFailure(t *testing.T) {
	owner, service := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	owner.enter = cancel
	if err := service.WithCurrent(ctx, func(*TaskBinding) error {
		t.Fatal("owner entry cancellation reached inspection")
		return nil
	}); !errors.Is(err, Cancelled) {
		t.Fatal(err)
	}

	owner, service = fixture(t)
	ctx, cancel = context.WithCancel(context.Background())
	if err := service.WithCurrent(ctx, func(*TaskBinding) error {
		cancel()
		return nil
	}); !errors.Is(err, Cancelled) {
		t.Fatal("cancelled final disclosure accepted", err)
	}

	owner, service = fixture(t)
	owner.after = errors.New("private owner diagnostic after inspection")
	if err := service.WithCurrent(context.Background(), func(*TaskBinding) error { return nil }); !errors.Is(err, Unavailable) {
		t.Fatal("owner return failure was treated as success", err)
	}
}

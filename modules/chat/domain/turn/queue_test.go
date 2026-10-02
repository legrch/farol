package turn

import (
	"errors"
	"fmt"
	"testing"
)

func queue(t *testing.T) *Queue {
	t.Helper()
	q, err := NewQueue("fixture-profile", "fixture-backend")
	if err != nil {
		t.Fatal(err)
	}
	return q
}

func add(t *testing.T, q *Queue, n string) Identity {
	t.Helper()
	i := identity(n)
	if _, err := q.Admit(i, digest); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Enqueue(i); err != nil {
		t.Fatal(err)
	}
	return i
}

func bind(t *testing.T, q *Queue) Binding {
	t.Helper()
	r, err := q.Reserve()
	if err != nil {
		t.Fatal(err)
	}
	s, err := q.Bind(r, Document{ViewID: fmt.Sprintf("view-%d", r.Ordinal), ViewGeneration: r.Generation, DocumentGeneration: 1, ConversationID: "conversation-" + r.Identity.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	return s.Binding
}

func complete(t *testing.T, q *Queue, b Binding) {
	t.Helper()
	if _, err := q.Dispatch(b); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Accept(b); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Delta(b, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Finish(b, Result{ID: "result-" + b.Reservation.Identity.TaskID, Outcome: Completed, Code: "COMPLETED"}); err != nil {
		t.Fatal(err)
	}
}

func TestFiveSlotsSixthWaitsAndReusesOnlyAfterSettlementAndAck(t *testing.T) {
	q := queue(t)
	var bindings []Binding
	for n := 1; n <= 6; n++ {
		add(t, q, fmt.Sprint(n))
	}
	for n := 1; n <= Slots; n++ {
		bindings = append(bindings, bind(t, q))
	}
	if _, err := q.Reserve(); !errors.Is(err, Capacity) {
		t.Fatalf("sixth view: %v", err)
	}
	s, err := q.Snapshot(identity("6"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Phase != Pending || s.Reserved || s.SendIntent {
		t.Fatal("queued request was dispatched")
	}
	b := bindings[0]
	complete(t, q, b)
	if err := q.Release(b.Reservation); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	if _, err := q.Settle(b); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(b.Reservation); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	if _, err := q.Acknowledge(b.Reservation.Identity, "result-"+b.Reservation.Identity.TaskID); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(b.Reservation); err != nil {
		t.Fatal(err)
	}
	next := bind(t, q)
	if next.Reservation.Ordinal != b.Reservation.Ordinal || next.Reservation.Generation != b.Reservation.Generation+1 || next.Reservation.Identity != identity("6") {
		t.Fatalf("wrong reuse: %+v", next)
	}
	old, err := q.Snapshot(b.Reservation.Identity)
	if err != nil {
		t.Fatal(err)
	}
	if old.Identity != identity("1") || old.Binding != b || old.Phase != Delivered {
		t.Fatal("history rebound to a slot")
	}
	if _, err := q.ActiveBinding(old.Identity); !errors.Is(err, NotFound) {
		t.Fatal("history opened replacement")
	}
	if _, err := q.Delta(b, 2); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
	if err := q.Release(b.Reservation); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
}

func TestUnknownKeepsSlotEvenAfterAck(t *testing.T) {
	q := queue(t)
	i := add(t, q, "a")
	b := bind(t, q)
	if _, err := q.Dispatch(b); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Cancel(i, "unknown-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Acknowledge(i, "unknown-a"); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(b.Reservation); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	s, err := q.Snapshot(i)
	if err != nil {
		t.Fatal(err)
	}
	if s.Phase != Unknown || s.LifecycleSettled {
		t.Fatal("unknown projected as settled")
	}
	if _, err := q.Dispatch(b); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
}

func TestDuplicateAdmissionConflictsAndIsObservationOnly(t *testing.T) {
	q := queue(t)
	i := add(t, q, "a")
	b := bind(t, q)
	if _, err := q.Dispatch(b); err != nil {
		t.Fatal(err)
	}
	s, err := q.Admit(i, digest)
	if err != nil {
		t.Fatal(err)
	}
	if !s.SendIntent || s.Phase != Running {
		t.Fatal("duplicate reset operation")
	}
	if _, err := q.Admit(i, fmt.Sprintf("%064d", 1)); !errors.Is(err, Conflict) {
		t.Fatal(err)
	}
	other := i
	other.TurnID = "different"
	if _, err := q.Admit(other, digest); !errors.Is(err, Conflict) {
		t.Fatal(err)
	}
	if _, err := q.Enqueue(i); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
	if _, err := q.Dispatch(b); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
}

func TestQueuedCancelAndPreparedDisposal(t *testing.T) {
	q := queue(t)
	i := add(t, q, "a")
	s, err := q.Cancel(i, "cancel-a")
	if err != nil {
		t.Fatal(err)
	}
	if !s.LifecycleSettled || s.SendIntent {
		t.Fatal("queued cancel unsettled")
	}
	if _, err := q.Reserve(); !errors.Is(err, NotFound) {
		t.Fatal(err)
	}
	i = add(t, q, "b")
	r, err := q.Reserve()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Cancel(i, "cancel-b"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Acknowledge(i, "cancel-b"); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(r); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	if _, err := q.SettlePrepared(r); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(r); err != nil {
		t.Fatal(err)
	}
}

func TestOneTaskCannotOwnTwoViews(t *testing.T) {
	q := queue(t)
	i := add(t, q, "a")
	first := bind(t, q)
	later := i
	later.TurnID = "later-turn"
	later.OperationID = "later-operation"
	later.Generation++
	if _, err := q.Admit(later, digest); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Enqueue(later); err != nil {
		t.Fatal(err)
	}
	add(t, q, "b")
	second := bind(t, q)
	if second.Reservation.Identity != identity("b") {
		t.Fatal("second turn occupied another view")
	}
	complete(t, q, first)
	if _, err := q.Settle(first); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Acknowledge(i, "result-"+i.TaskID); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(first.Reservation); err != nil {
		t.Fatal(err)
	}
	next := bind(t, q)
	if next.Reservation.Identity != later {
		t.Fatal("later turn lost")
	}
}

func TestBoundsAndProfileIsolation(t *testing.T) {
	q := queue(t)
	foreign := identity("foreign")
	foreign.ProfileID = "another-profile"
	if _, err := q.Admit(foreign, digest); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	for n := 0; n < MaxRequests; n++ {
		i := identity(fmt.Sprint(n))
		if _, err := q.Admit(i, digest); err != nil {
			t.Fatal(err)
		}
		if n < MaxPending {
			if _, err := q.Enqueue(i); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := q.Enqueue(identity(fmt.Sprint(MaxPending))); !errors.Is(err, Capacity) {
		t.Fatal(err)
	}
	if _, err := q.Admit(identity("extra"), digest); !errors.Is(err, Capacity) {
		t.Fatal(err)
	}
	// Saturation cannot prevent exact observation of an already admitted operation.
	if _, err := q.Admit(identity("0"), digest); err != nil {
		t.Fatal(err)
	}
}

func TestLogicalTurnAndNativeViewCannotBeDuplicated(t *testing.T) {
	q := queue(t)
	i := add(t, q, "a")
	first := bind(t, q)
	duplicate := i
	duplicate.OperationID = "another-operation"
	if _, err := q.Admit(duplicate, digest); !errors.Is(err, Conflict) {
		t.Fatalf("duplicate logical turn: %v", err)
	}
	add(t, q, "b")
	r, err := q.Reserve()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Bind(r, first.Document); !errors.Is(err, Conflict) {
		t.Fatalf("same physical view: %v", err)
	}
	s, err := q.Snapshot(r.Identity)
	if err != nil {
		t.Fatal(err)
	}
	if s.Bound {
		t.Fatal("failed bind was partially applied")
	}
}

func TestSlotGenerationNeverWraps(t *testing.T) {
	q := queue(t)
	for n := range q.generations {
		q.generations[n] = ^uint64(0)
	}
	add(t, q, "a")
	if _, err := q.Reserve(); !errors.Is(err, Capacity) {
		t.Fatal("wrapped slot lease")
	}
}

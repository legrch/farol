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
	if _, err := q.Settle(QuiescenceEvidence{Binding: b, ResultID: "result-" + b.Reservation.Identity.TaskID, Sequence: 2, Confirmed: true}); err != nil {
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
	if _, err := q.SettlePrepared(DisposalEvidence{Reservation: r, ResultID: "cancel-b", Confirmed: true}); err != nil {
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
	if _, err := q.Settle(QuiescenceEvidence{Binding: first, ResultID: "result-" + i.TaskID, Sequence: 2, Confirmed: true}); err != nil {
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

func TestGenericCancelledResultCannotReleasePreparedOrSentSlot(t *testing.T) {
	for _, sent := range []bool{false, true} {
		t.Run(fmt.Sprint(sent), func(t *testing.T) {
			q := queue(t)
			i := add(t, q, "a")
			b := bind(t, q)
			if sent {
				if _, err := q.Dispatch(b); err != nil {
					t.Fatal(err)
				}
			}
			before, err := q.Snapshot(i)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := q.Finish(b, Result{ID: "unproven-cancel", Outcome: CancelledOutcome, Code: "CANCELLED"}); !errors.Is(err, Transition) {
				t.Fatal("unproven cancellation accepted", err)
			}
			after, err := q.Snapshot(i)
			if err != nil {
				t.Fatal(err)
			}
			if after != before {
				t.Fatal("rejected cancellation changed state")
			}
			if _, err := q.Settle(QuiescenceEvidence{Binding: b, ResultID: "unproven-cancel", Sequence: 1, Confirmed: true}); !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			if _, err := q.Acknowledge(i, "unproven-cancel"); !errors.Is(err, Correlation) {
				t.Fatal(err)
			}
			if err := q.Release(b.Reservation); !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			s, err := q.Cancel(i, "local-cancel")
			if err != nil {
				t.Fatal(err)
			}
			if sent && s.Phase != Unknown {
				t.Fatal("sent cancellation lost unknown state")
			}
		})
	}
}

func TestReservedCancellationNeedsPositiveCleanupEvidence(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(fmt.Sprint(bound), func(t *testing.T) {
			q := queue(t)
			i := add(t, q, "a")
			r, err := q.Reserve()
			if err != nil {
				t.Fatal(err)
			}
			b := Binding{Reservation: r, Document: Document{ViewID: "view-a", ViewGeneration: 2, DocumentGeneration: 3, ConversationID: "conversation-a"}}
			if bound {
				if _, err := q.Bind(r, b.Document); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := q.Cancel(i, "cancel-a"); err != nil {
				t.Fatal(err)
			}
			before, err := q.Acknowledge(i, "cancel-a")
			if err != nil || before.LifecycleSettled {
				t.Fatal("ACK settled a reserved cancellation", err)
			}
			unchanged := func(err, want error) {
				t.Helper()
				if !errors.Is(err, want) {
					t.Fatalf("cleanup error %v, want %v", err, want)
				}
				after, err := q.Snapshot(i)
				if err != nil || after != before {
					t.Fatal("rejected cleanup changed state", err)
				}
				if err := q.Release(r); !errors.Is(err, Unsettled) {
					t.Fatal("unproven cleanup released slot", err)
				}
			}
			if bound {
				good := QuiescenceEvidence{Binding: b, ResultID: "cancel-a", Sequence: 1, Confirmed: true}
				invalid := []struct {
					evidence QuiescenceEvidence
					code     Code
				}{
					{func() QuiescenceEvidence { e := good; e.Confirmed = false; return e }(), Unsettled},
					{func() QuiescenceEvidence { e := good; e.Sequence = 0; return e }(), Sequence},
					{func() QuiescenceEvidence { e := good; e.ResultID = "foreign-result"; return e }(), Correlation},
					{func() QuiescenceEvidence { e := good; e.Binding.Reservation.Generation++; return e }(), Correlation},
					{func() QuiescenceEvidence {
						e := good
						e.Binding.Reservation.BackendGeneration = "old-backend"
						return e
					}(), Correlation},
					{func() QuiescenceEvidence { e := good; e.Binding.Document.ViewGeneration++; return e }(), Correlation},
					{func() QuiescenceEvidence { e := good; e.Binding.Document.DocumentGeneration++; return e }(), Correlation},
					{func() QuiescenceEvidence {
						e := good
						e.Binding.Document.ConversationID = "foreign-conversation"
						return e
					}(), Correlation},
				}
				for _, test := range invalid {
					_, err := q.Settle(test.evidence)
					unchanged(err, test.code)
				}
				_, err := q.SettlePrepared(DisposalEvidence{Reservation: r, ResultID: "cancel-a", Confirmed: true})
				unchanged(err, Unsettled)
				if _, err := q.Settle(good); err != nil {
					t.Fatal(err)
				}
			} else {
				good := DisposalEvidence{Reservation: r, ResultID: "cancel-a", Confirmed: true}
				invalid := []struct {
					evidence DisposalEvidence
					code     Code
				}{
					{func() DisposalEvidence { e := good; e.Confirmed = false; return e }(), Unsettled},
					{func() DisposalEvidence { e := good; e.ResultID = "foreign-result"; return e }(), Correlation},
					{func() DisposalEvidence { e := good; e.Reservation.Generation++; return e }(), Correlation},
					{func() DisposalEvidence { e := good; e.Reservation.BackendGeneration = "old-backend"; return e }(), Correlation},
					{func() DisposalEvidence { e := good; e.Reservation.Ordinal++; return e }(), Correlation},
				}
				for _, test := range invalid {
					_, err := q.SettlePrepared(test.evidence)
					unchanged(err, test.code)
				}
				_, err := q.Settle(QuiescenceEvidence{Binding: b, ResultID: "cancel-a", Sequence: 1, Confirmed: true})
				unchanged(err, Correlation)
				if _, err := q.SettlePrepared(good); err != nil {
					t.Fatal(err)
				}
			}
			if err := q.Release(r); err != nil {
				t.Fatal(err)
			}
			add(t, q, "next")
			next, err := q.Reserve()
			if err != nil || next.Ordinal != r.Ordinal || next.Generation != r.Generation+1 {
				t.Fatal("confirmed cleanup did not advance slot generation", err)
			}
		})
	}
}

func TestReusedComputerIDAndStaleResolutionKeepNewCallFenced(t *testing.T) {
	q := queue(t)
	i := add(t, q, "a")
	b := bind(t, q)
	if _, err := q.Dispatch(b); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Accept(b); err != nil {
		t.Fatal(err)
	}
	if _, err := q.RequestComputer(b, "call-a"); err != nil {
		t.Fatal(err)
	}
	before, err := q.ResolveComputer(b, "call-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.RequestComputer(b, "call-a"); !errors.Is(err, Conflict) {
		t.Fatal("resolved call ID was reused", err)
	}
	after, err := q.Snapshot(i)
	if err != nil || after != before {
		t.Fatal("reused request changed state", err)
	}
	before, err = q.RequestComputer(b, "call-b")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.ResolveComputer(b, "call-a"); !errors.Is(err, Correlation) {
		t.Fatal("stale resolution cleared new call", err)
	}
	after, err = q.Snapshot(i)
	if err != nil || after != before || after.OutstandingCallID != "call-b" {
		t.Fatal("stale resolution changed current call fence", err)
	}
	if _, err := q.Delta(b, 1); !errors.Is(err, Transition) {
		t.Fatal("stale resolution resumed output", err)
	}
	result := Result{ID: "result-a", Outcome: Completed, Code: "COMPLETED"}
	if _, err := q.Finish(b, result); !errors.Is(err, Transition) {
		t.Fatal("stale resolution permitted completion", err)
	}
	if _, err := q.ResolveComputer(b, "call-b"); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Delta(b, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Finish(b, result); err != nil {
		t.Fatal(err)
	}
}

func TestCandidateCloneDoesNotMutateCommittedQueue(t *testing.T) {
	q := queue(t)
	first := add(t, q, "clone-first")
	second := add(t, q, "clone-second")
	candidate := q.Clone()
	b := bind(t, candidate)
	if b.Reservation.Identity != first {
		t.Fatal("candidate changed FIFO")
	}
	if _, err := candidate.Dispatch(b); err != nil {
		t.Fatal(err)
	}
	if _, err := candidate.Accept(b); err != nil {
		t.Fatal(err)
	}
	if _, err := candidate.RequestComputer(b, "candidate-call"); err != nil {
		t.Fatal(err)
	}
	if _, err := candidate.ResolveComputer(b, "candidate-call"); err != nil {
		t.Fatal(err)
	}
	if _, err := candidate.Cancel(second, "candidate-cancel"); err != nil {
		t.Fatal(err)
	}
	original, err := q.Snapshot(first)
	if err != nil || original.Reserved || original.SendIntent || original.Phase != Pending {
		t.Fatalf("original mutated: %+v %v", original, err)
	}
	originalSecond, _ := q.Snapshot(second)
	if originalSecond.HasResult || originalSecond.Phase != Pending {
		t.Fatal("candidate cancellation changed original")
	}
	originalBinding := bind(t, q)
	if originalBinding.Reservation != b.Reservation {
		t.Fatal("candidate consumed original generation/FIFO")
	}
	if _, err := q.Dispatch(originalBinding); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Accept(originalBinding); err != nil {
		t.Fatal(err)
	}
	if _, err := q.RequestComputer(originalBinding, "candidate-call"); err != nil {
		t.Fatal("candidate call history leaked", err)
	}
	if _, err := candidate.RequestComputer(b, "candidate-call"); !errors.Is(err, Conflict) {
		t.Fatal("candidate lost call tombstone", err)
	}
	if next, err := q.Reserve(); err != nil || next.Identity != second {
		t.Fatal("candidate changed waiting storage", next, err)
	}
}

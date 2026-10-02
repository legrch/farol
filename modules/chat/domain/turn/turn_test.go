package turn

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func identity(n string) Identity {
	return Identity{ProfileID: "fixture-profile", OwnerID: "fixture-owner", SessionID: "fixture-session", TaskID: "task-" + n, TurnID: "turn-" + n, OperationID: "operation-" + n, Generation: 7}
}

var digest = strings.Repeat("a", 64)

func prepared(t *testing.T) (Turn, Binding) {
	t.Helper()
	turn, err := New(identity("a"), digest)
	if err != nil {
		t.Fatal(err)
	}
	turn, err = turn.wait()
	if err != nil {
		t.Fatal(err)
	}
	r := Reservation{Identity: turn.identity, Ordinal: 1, Generation: 1, BackendGeneration: "fixture-backend"}
	turn, err = turn.reserve(r)
	if err != nil {
		t.Fatal(err)
	}
	turn, err = turn.Bind(r, Document{ViewID: "view-a", ViewGeneration: 2, DocumentGeneration: 3, ConversationID: "conversation-a"})
	if err != nil {
		t.Fatal(err)
	}
	return turn, turn.binding
}

func running(t *testing.T) (Turn, Binding) {
	t.Helper()
	turn, b := prepared(t)
	turn, err := turn.Dispatch(b)
	if err != nil {
		t.Fatal(err)
	}
	turn, err = turn.Accept(b)
	if err != nil {
		t.Fatal(err)
	}
	return turn, b
}

func TestFixtures(t *testing.T) {
	// All events are synthetic metadata. This proves no DOM/provider or journal IO.
	data, err := os.ReadFile("testdata/lifecycle.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name         string
		Events       []string
		Phase        Phase
		Outcome      Outcome
		Acknowledged bool
		Reusable     bool
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			turn, b := prepared(t)
			for _, event := range f.Events {
				var err error
				switch event {
				case "send":
					turn, err = turn.Dispatch(b)
				case "accepted":
					turn, err = turn.Accept(b)
				case "delta":
					turn, err = turn.Delta(b, 1)
				case "await-owner":
					turn, err = turn.AwaitOwner(b)
				case "resume":
					turn, err = turn.Resume(b)
				case "complete":
					turn, err = turn.Finish(b, Result{ID: "result-a", Outcome: Completed, Code: "COMPLETED"})
				case "refused":
					turn, err = turn.Finish(b, Result{ID: "result-a", Outcome: Refused, Code: "PROVIDER_REFUSED"})
				case "lost-reply":
					turn, err = turn.Finish(b, Result{ID: "result-a", Outcome: UnknownOutcome, Code: "SEND_REPLY_LOST"})
				case "cancel":
					turn, err = turn.Cancel("result-a")
				case "ack":
					turn, err = turn.Acknowledge(turn.identity, "result-a")
				case "quiescent":
					turn, err = turn.Settle(QuiescenceEvidence{Binding: b, ResultID: "result-a", Sequence: turn.lastSequence + 1, Confirmed: true})
				default:
					t.Fatalf("unknown fixture event %q", event)
				}
				if err != nil {
					t.Fatalf("%s: %v", event, err)
				}
			}
			s := turn.Snapshot()
			if s.Phase != f.Phase || s.Result.Outcome != f.Outcome || s.DeliveryAcknowledged != f.Acknowledged || turn.Reusable() != f.Reusable {
				t.Fatalf("unexpected projection: %+v", s)
			}
		})
	}
}

func TestActivationAcceptanceAndCompletion(t *testing.T) {
	turn, b := prepared(t)
	if _, err := turn.Accept(b); !errors.Is(err, Transition) {
		t.Fatalf("accept before send: %v", err)
	}
	turn, err := turn.Dispatch(b)
	if err != nil {
		t.Fatal(err)
	}
	if turn.accepted || !turn.sendIntent {
		t.Fatal("send and acceptance collapsed")
	}
	if _, err := turn.Dispatch(b); !errors.Is(err, Transition) {
		t.Fatalf("repeated send: %v", err)
	}
	if _, err := turn.Delta(b, 1); !errors.Is(err, Transition) {
		t.Fatalf("delta before acceptance: %v", err)
	}
	turn, err = turn.Accept(b)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := turn.Finish(b, Result{ID: "result-a", Outcome: Completed, Code: "COMPLETED"}); !errors.Is(err, NoDelta) {
		t.Fatalf("empty completion: %v", err)
	}
}

func TestExactBindingAndSequence(t *testing.T) {
	turn, b := running(t)
	for _, mutate := range []func(*Binding){
		func(b *Binding) { b.Reservation.Identity.ProfileID = "foreign" },
		func(b *Binding) { b.Reservation.Identity.OwnerID = "foreign" },
		func(b *Binding) { b.Reservation.Identity.SessionID = "foreign" },
		func(b *Binding) { b.Reservation.Identity.TaskID = "foreign" },
		func(b *Binding) { b.Reservation.Identity.TurnID = "foreign" },
		func(b *Binding) { b.Reservation.Identity.OperationID = "foreign" },
		func(b *Binding) { b.Reservation.Identity.Generation++ },
		func(b *Binding) { b.Reservation.Ordinal++ },
		func(b *Binding) { b.Reservation.Generation++ },
		func(b *Binding) { b.Reservation.BackendGeneration = "foreign" },
		func(b *Binding) { b.Document.ViewID = "foreign" },
		func(b *Binding) { b.Document.ViewGeneration++ },
		func(b *Binding) { b.Document.DocumentGeneration++ },
		func(b *Binding) { b.Document.ConversationID = "foreign" },
	} {
		foreign := b
		mutate(&foreign)
		changed, err := turn.Delta(foreign, 1)
		if !errors.Is(err, Correlation) || changed != turn {
			t.Fatalf("foreign event changed turn: %+v %v", foreign, err)
		}
	}
	first, err := turn.Delta(b, 9) // Legacy Turn accepts strictly increasing, not contiguous sequence.
	if err != nil {
		t.Fatal(err)
	}
	for _, seq := range []uint64{0, 8, 9} {
		changed, err := first.Delta(b, seq)
		if !errors.Is(err, Sequence) || changed != first {
			t.Fatalf("sequence %d: %v", seq, err)
		}
	}
	if _, err := first.Delta(b, 10); err != nil {
		t.Fatal(err)
	}
}

func TestOwnerWaitDoesNotResetSend(t *testing.T) {
	turn, b := running(t)
	turn, err := turn.AwaitOwner(b)
	if err != nil {
		t.Fatal(err)
	}
	turn, err = turn.Resume(b)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := turn.Dispatch(b); !errors.Is(err, Transition) {
		t.Fatalf("owner wait allowed resend: %v", err)
	}
}

func TestKnownResultSurvivesLostDeliveryAndUnknownIsSticky(t *testing.T) {
	turn, b := running(t)
	turn, err := turn.Delta(b, 1)
	if err != nil {
		t.Fatal(err)
	}
	result := Result{ID: "result-a", Outcome: Completed, Code: "COMPLETED"}
	turn, err = turn.Finish(b, result)
	if err != nil {
		t.Fatal(err)
	}
	if turn.phase != ResultReady || turn.acknowledged || turn.Reusable() {
		t.Fatal("completion forged delivery")
	}
	same, err := turn.Finish(b, result)
	if err != nil || same != turn {
		t.Fatal("retained result replay is not idempotent")
	}
	if _, err := turn.Acknowledge(identity("b"), result.ID); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	if _, err := turn.Acknowledge(turn.identity, "foreign"); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	if _, err := turn.Finish(b, Result{ID: "different", Outcome: Completed, Code: "COMPLETED"}); !errors.Is(err, Conflict) {
		t.Fatal(err)
	}
	unknown, b := running(t)
	unknown, err = unknown.Finish(b, Result{ID: "unknown-a", Outcome: UnknownOutcome, Code: "SEND_REPLY_LOST"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := unknown.Settle(QuiescenceEvidence{Binding: b, ResultID: "unknown-a", Sequence: 1, Confirmed: true}); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	if _, err := unknown.Finish(b, result); !errors.Is(err, Conflict) {
		t.Fatal(err)
	}
	if _, err := unknown.Delta(b, 1); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
	if _, err := unknown.Dispatch(b); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
}

func TestMetadataHasNoContent(t *testing.T) {
	turn, _ := prepared(t)
	encoded, err := json.Marshal(turn.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	for _, secretField := range []string{"prompt", "answer", "cookie", "token", "digest"} {
		if strings.Contains(strings.ToLower(string(encoded)), secretField) {
			t.Fatalf("projection exposes %s", secretField)
		}
	}
}

func TestValidation(t *testing.T) {
	for _, invalid := range []Identity{{}, func() Identity { i := identity("a"); i.Generation = 0; return i }(), func() Identity { i := identity("a"); i.TaskID = "has space"; return i }()} {
		if _, err := New(invalid, digest); !errors.Is(err, Invalid) {
			t.Fatal(err)
		}
	}
	for _, d := range []string{"", strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		if _, err := New(identity("a"), d); !errors.Is(err, Invalid) {
			t.Fatal(err)
		}
	}
}

func TestComputerResultBindsExactCallAndLostAckNeverResumes(t *testing.T) {
	turn, b := running(t)
	turn, err := turn.RequestComputer(b, "call-a")
	if err != nil {
		t.Fatal(err)
	}
	if turn.Snapshot().OutstandingCallID != "call-a" {
		t.Fatal("Activity lost pending tool")
	}
	if _, err := turn.Delta(b, 1); !errors.Is(err, Transition) {
		t.Fatal("delta while waiting for tool", err)
	}
	if _, err := turn.ResolveComputer(b, "foreign-call"); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	foreign := b
	foreign.Reservation.Identity.Generation++
	if _, err := turn.ResolveComputer(foreign, "call-a"); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	resolved, err := turn.ResolveComputer(b, "call-a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resolved.Delta(b, 1); err != nil {
		t.Fatal(err)
	}
	unknown, err := turn.Finish(b, Result{ID: "unknown-tool", Outcome: UnknownOutcome, Code: "TOOL_RESULT_ACK_LOST"})
	if err != nil {
		t.Fatal(err)
	}
	if unknown.Snapshot().OutstandingCallID != "" || unknown.phase != Unknown {
		t.Fatal("unknown kept a resumable call")
	}
	if _, err := unknown.ResolveComputer(b, "call-a"); !errors.Is(err, Correlation) {
		t.Fatal(err)
	}
	if _, err := unknown.RequestComputer(b, "call-a"); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
	if _, err := unknown.Dispatch(b); !errors.Is(err, Transition) {
		t.Fatal(err)
	}
}

func TestQuiescenceMustFollowLatestOutputAndNameExactResult(t *testing.T) {
	turn, b := running(t)
	turn, err := turn.Delta(b, 9)
	if err != nil {
		t.Fatal(err)
	}
	turn, err = turn.Finish(b, Result{ID: "result-a", Outcome: Completed, Code: "COMPLETED"})
	if err != nil {
		t.Fatal(err)
	}
	for _, sequence := range []uint64{0, 8, 9} {
		changed, err := turn.Settle(QuiescenceEvidence{Binding: b, ResultID: "result-a", Sequence: sequence, Confirmed: true})
		if !errors.Is(err, Sequence) || changed != turn {
			t.Fatal("stale quiescence changed result lifecycle", err)
		}
	}
	changed, err := turn.Settle(QuiescenceEvidence{Binding: b, ResultID: "foreign-result", Sequence: 10, Confirmed: true})
	if !errors.Is(err, Correlation) || changed != turn {
		t.Fatal("foreign result settled lifecycle", err)
	}
	changed, err = turn.Settle(QuiescenceEvidence{Binding: b, ResultID: "result-a", Sequence: 10})
	if !errors.Is(err, Unsettled) || changed != turn {
		t.Fatal("unconfirmed observation settled lifecycle", err)
	}
	settled, err := turn.Settle(QuiescenceEvidence{Binding: b, ResultID: "result-a", Sequence: 10, Confirmed: true})
	if err != nil || !settled.settled || settled.Reusable() {
		t.Fatal("quiescence was not independent of delivery ACK", err)
	}
}

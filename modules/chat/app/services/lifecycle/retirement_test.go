package lifecycle

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
)

// CPU port fixtures exercise the real owner. They do not qualify filesystem,
// process exit, host receipt retention, browser cleanup origin or durability.
type retirementJournal struct {
	journalFixture
	retireCalls int
	retireFault string
	retireHook  func()
	retirement  port.RetirementWrite
}

func (j *retirementJournal) Retire(_ context.Context, w port.RetirementWrite) (*port.RetirementReceipt, error) {
	j.retireCalls++
	j.retirement = port.CopyRetirement(w)
	if j.retireHook != nil {
		j.retireHook()
	}
	r := &port.RetirementReceipt{Write: port.CopyRetirement(w), PublicationDigest: [32]byte{1}}
	switch j.retireFault {
	case "error":
		return nil, errors.New("fixture lost retirement reply")
	case "nil":
		return nil, nil
	case "root":
		r.Write.Root.Inode++
	case "scope":
		r.Write.Scope.BackendGeneration = "other"
	case "revision":
		r.Write.Revision++
	case "turn":
		r.Write.Turns[0].AcknowledgedRevision++
	case "digest":
		r.PublicationDigest = [32]byte{}
	}
	return r, nil
}

func retiringOwner(t *testing.T) (*Service, *retirementJournal, *browserFixture) {
	t.Helper()
	j, b := &retirementJournal{}, &browserFixture{}
	s, err := New(context.Background(), port.JournalScope{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend"}, Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: &resultFixture{}, ResultBytesLimit: 1024})
	if err != nil {
		t.Fatal(err)
	}
	return s, j, b
}

func cleanCancelled(t *testing.T, s *Service, n string) *Handle {
	t.Helper()
	h := admit(t, s, n)
	if _, err := s.Cancel(context.Background(), h, "cancel-"+n); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "cancel-" + n})
	return h
}

func receiptOf(t *testing.T, proof port.CleanRetirement) port.RetirementReceipt {
	t.Helper()
	var r port.RetirementReceipt
	if err := proof.WithRetirement(context.Background(), func(value *port.RetirementReceipt) error { r = *value; return nil }); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestCleanRetirementRetainsExactWitnessAndKnownRevision(t *testing.T) {
	s, j, _ := retiringOwner(t)
	h := admit(t, s, "1")
	b := running(t, s, h)
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finish(context.Background(), h, b, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("fixture answer")); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "result"})
	ackRev := s.revision
	evidence := turn.QuiescenceEvidence{Binding: b, ResultID: "result", Sequence: 93, Confirmed: true}
	applyOK(t, s, h, Change{Action: Settle, Quiescence: evidence})
	settleRev := s.revision
	applyOK(t, s, h, Change{Action: Release, Reservation: b.Reservation})
	releaseRev := s.revision
	// Duplicate ACK/event does not erase the original release prerequisites.
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "result"})
	later := evidence
	later.Sequence++
	applyOK(t, s, h, Change{Action: Settle, Quiescence: later})
	oldRev := s.revision
	proof, err := s.Retire(context.Background())
	if err != nil || proof == nil || j.retireCalls != 1 {
		t.Fatal(proof, err)
	}
	r := receiptOf(t, proof)
	if r.Write.PreviousRevision != oldRev || r.Write.Revision != oldRev+1 || r.Write.Root != s.root || len(r.Write.Turns) != 1 {
		t.Fatal("wrong owner/revision", r)
	}
	got := r.Write.Turns[0]
	if got.Quiescence != evidence || got.AcknowledgedRevision != ackRev || got.SettledRevision != settleRev || got.ReleasedRevision != releaseRev {
		t.Fatal("synthesized or erased actual witness", got)
	}
	expectCurrent(t, h, false)
	if _, err := s.Admit(context.Background(), route("2"), intentDigest); !errors.Is(err, Frozen) {
		t.Fatal("retired admission", err)
	}
	if _, err := s.Retire(context.Background()); !errors.Is(err, Frozen) || j.retireCalls != 1 {
		t.Fatal("retirement replay", err)
	}
	r.Write.Turns[0].Binding.TaskEpoch++
	if receiptOf(t, proof).Write.Turns[0].Binding != h.fixed {
		t.Fatal("proof aliased callback copy")
	}
}

func TestFreezeRefusesNewEffectsButAllowsOriginalReplyAndCleanup(t *testing.T) {
	s, j, browser := retiringOwner(t)
	h := admit(t, s, "1")
	b := prepared(t, s, h)
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := j.count()
	if _, err := s.Admit(context.Background(), route("2"), intentDigest); !errors.Is(err, Frozen) {
		t.Fatal(err)
	}
	if _, err := s.PrepareNext(context.Background(), 1000); !errors.Is(err, Frozen) {
		t.Fatal(err)
	}
	if _, err := s.Send(context.Background(), h, "fixture prompt", 1000, "send-result"); !errors.Is(err, Frozen) {
		t.Fatal(err)
	}
	if j.count() != before {
		t.Fatal("frozen effect wrote intent")
	}
	if _, sends := browser.counts(); sends != 0 {
		t.Fatal("frozen Send executed")
	}
	if _, err := s.Cancel(context.Background(), h, "cancel"); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "cancel"})
	applyOK(t, s, h, Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: b, ResultID: "cancel", Sequence: 14, Confirmed: true}})
	applyOK(t, s, h, Change{Action: Release, Reservation: b.Reservation})
	if _, err := s.Retire(context.Background()); err != nil {
		t.Fatal(err)
	}

	s, _, browser = retiringOwner(t)
	h = admit(t, s, "1")
	b = prepared(t, s, h)
	browser.sendHook = func(port.SendRequest) {
		if err := s.FreezeAdmissions(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Send(context.Background(), h, "fixture prompt", 1000, "result"); err != nil {
		t.Fatal("original Send settlement blocked", err)
	}
	applyOK(t, s, h, Change{Action: Accept, Binding: b})
	applyOK(t, s, h, Change{Action: Delta, Binding: b, Sequence: 1})
	if _, err := s.Apply(context.Background(), h, Change{Action: RequestComputer, Binding: b, CallID: "new-call"}); !errors.Is(err, Frozen) {
		t.Fatal("new Computer effect after freeze", err)
	}
}

func TestRetirementRequiresTerminalExplicitACKCleanupAndRelease(t *testing.T) {
	for _, missing := range []string{"result", "ack", "cleanup", "release", "witness"} {
		t.Run(missing, func(t *testing.T) {
			s, j, _ := retiringOwner(t)
			h := admit(t, s, "1")
			b := running(t, s, h)
			if missing != "result" {
				if _, err := s.Finish(context.Background(), h, b, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, nil); err != nil {
					t.Fatal(err)
				}
				if missing != "ack" {
					applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "result"})
				}
				if missing != "cleanup" {
					applyOK(t, s, h, Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: b, ResultID: "result", Sequence: 70, Confirmed: true}})
				}
				if missing == "witness" {
					applyOK(t, s, h, Change{Action: Release, Reservation: b.Reservation})
					h.quiescence = turn.QuiescenceEvidence{} // corruption cannot be patched from settled=true
				}
			}
			if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, Unsettled) || j.retireCalls != 0 {
				t.Fatal("incomplete owner retired", proof, err)
			}
			if _, err := s.Admit(context.Background(), route("2"), intentDigest); !errors.Is(err, Frozen) {
				t.Fatal("preflight thawed admission", err)
			}
		})
	}
}

func TestRetirementCannotEraseUnknownPendingOrUnresolvedComputerCall(t *testing.T) {
	s, j, browser := retiringOwner(t)
	h := admit(t, s, "1")
	b := prepared(t, s, h)
	browser.sendFault = "unknown"
	if _, err := s.Send(context.Background(), h, "fixture prompt", 1000, "unknown"); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "unknown"})
	if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, Unsettled) || j.retireCalls != 0 {
		t.Fatal("unknown erased", proof, err)
	}

	s, j, _ = retiringOwner(t)
	h = admit(t, s, "1")
	j.hook = func(port.JournalWrite) {
		if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, Busy) {
			t.Fatal("pending owner retired", err)
		}
	}
	applyOK(t, s, h, Change{Action: Enqueue})
	if j.retireCalls != 0 {
		t.Fatal("pending retirement IO")
	}

	s, j, _ = retiringOwner(t)
	h = admit(t, s, "1")
	b = running(t, s, h)
	applyOK(t, s, h, Change{Action: RequestComputer, Binding: b, CallID: "actual-call"})
	if _, err := s.Finish(context.Background(), h, b, turn.Result{ID: "failure", Outcome: turn.Failed, Code: "FAILED"}, nil); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "failure"})
	applyOK(t, s, h, Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: b, ResultID: "failure", Sequence: 4, Confirmed: true}})
	applyOK(t, s, h, Change{Action: Release, Reservation: b.Reservation})
	if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, Unsettled) || j.retireCalls != 0 {
		t.Fatal("terminal snapshot erased unresolved call", err)
	}
}

func TestRetirementFailureCancellationOrLateReceiptNeverMintsProof(t *testing.T) {
	for _, fault := range []string{"error", "nil", "root", "scope", "revision", "turn", "digest", "cancel", "fence"} {
		t.Run(fault, func(t *testing.T) {
			s, j, _ := retiringOwner(t)
			h := cleanCancelled(t, s, "1")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			j.retireFault = fault
			j.retireHook = func() {
				expectUnavailable(t, h)
				if _, err := s.Apply(context.Background(), h, Change{Action: Acknowledge, ResultID: "cancel-1"}); !errors.Is(err, Busy) {
					t.Fatal("effect during retirement", err)
				}
				if fault == "cancel" {
					cancel()
				}
				if fault == "fence" {
					s.deps.Gate.Lock()
					s.fence++
					s.deps.Gate.Unlock()
				}
			}
			if proof, err := s.Retire(ctx); proof != nil || !errors.Is(err, Unsettled) {
				t.Fatal("uncertain proof", proof, err)
			}
			if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, Unsettled) || j.retireCalls != 1 {
				t.Fatal("retirement retry", proof, err)
			}
			expectUnavailable(t, h)
		})
	}
}

func TestEmptyAndUnreservedCancelledOwnersCanRetireWithoutFabricatedCleanup(t *testing.T) {
	for _, empty := range []bool{true, false} {
		s, j, _ := retiringOwner(t)
		if !empty {
			cleanCancelled(t, s, "1")
		}
		proof, err := s.Retire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		r := receiptOf(t, proof)
		if j.retireCalls != 1 || r.Write.Turns == nil {
			t.Fatal("missing explicit empty ledger")
		}
		if !empty && (r.Write.Turns[0].SettledRevision != 0 || r.Write.Turns[0].Quiescence != (turn.QuiescenceEvidence{})) {
			t.Fatal("fabricated cleanup")
		}
	}
	s, j, _ := retiringOwner(t)
	s.fence = math.MaxUint64
	if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, Unsettled) || j.retireCalls != 0 {
		t.Fatal("exhausted owner retired", err)
	}
}

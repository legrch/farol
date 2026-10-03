package lifecycle

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	app "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
)

// These use the actual Chat owner/adapter with CPU storage fixtures only. The
// fixture lease models serialization but proves no native flock/rename/fsync.
func liveFixture(t *testing.T, bound bool) (*Repository, *physicalFixture, *app.Service, *app.Handle) {
	t.Helper()
	p := &physicalFixture{}
	r, err := claimFixture(t, p)
	if err != nil {
		t.Fatal(err)
	}
	s, err := app.New(context.Background(), scope, app.Dependencies{Gate: gate.New(), Journal: r, Browser: exactBrowser{}, Results: exactResults{}, ResultBytesLimit: 1024})
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.Admit(context.Background(), binding(), digest)
	if err != nil {
		t.Fatal(err)
	}
	if !bound {
		if _, err := s.Cancel(context.Background(), h, "cancel"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Apply(context.Background(), h, app.Change{Action: app.Acknowledge, ResultID: "cancel"}); err != nil {
			t.Fatal(err)
		}
		return r, p, s, h
	}
	apply := func(c app.Change) *turn.Snapshot {
		t.Helper()
		view, err := s.Apply(context.Background(), h, c)
		if err != nil {
			t.Fatal(err)
		}
		return view
	}
	apply(app.Change{Action: app.Enqueue})
	if _, err := s.PrepareNext(context.Background(), 1000); err != nil {
		t.Fatal(err)
	}
	view, err := s.Send(context.Background(), h, "fixture private prompt", 1000, "send-failure")
	if err != nil {
		t.Fatal(err)
	}
	b := view.Binding
	apply(app.Change{Action: app.Accept, Binding: b})
	apply(app.Change{Action: app.RequestComputer, Binding: b, CallID: "call"})
	apply(app.Change{Action: app.ResolveComputer, Binding: b, CallID: "call"})
	apply(app.Change{Action: app.Delta, Binding: b, Sequence: 1})
	if _, err := s.Finish(context.Background(), h, b, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("fixture private answer")); err != nil {
		t.Fatal(err)
	}
	apply(app.Change{Action: app.Acknowledge, ResultID: "result"})
	e := turn.QuiescenceEvidence{Binding: b, ResultID: "result", Sequence: 71, Confirmed: true}
	apply(app.Change{Action: app.Settle, Quiescence: e})
	apply(app.Change{Action: app.Release, Reservation: b.Reservation})
	apply(app.Change{Action: app.Acknowledge, ResultID: "result"})
	return r, p, s, h
}

func successorFixture(p *physicalFixture, origin port.CleanRetirement, next port.JournalScope, limits Limits) (*Repository, error) {
	proof, err := captureProof(context.Background(), origin)
	if err != nil || p.leased {
		return nil, failure(Refused, false)
	}
	p.leased = true
	r := newOwner("profile", limits, &fixtureStorage{root: p}, fixtureRoot)
	if err := qualifySuccessor(context.Background(), r, next, proof); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

func TestActualKnownCleanRetirementAdmitsOnlyEmptySuccessor(t *testing.T) {
	r, p, s, old := liveFixture(t, true)
	proof, err := s.Retire(context.Background())
	if err != nil || proof == nil {
		t.Fatal(proof, err)
	}
	known, err := captureProof(context.Background(), proof)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := decode(p.raw, r.owner.limits)
	if err != nil || stored.Retirement == nil || !port.SameRetirement(*stored.Retirement, known.Write) {
		t.Fatal("retirement publication mismatch", err)
	}
	e := known.Write.Turns[0].Quiescence
	if e.Sequence != 71 || e.Binding.Document.ViewID != "view" || p.closes != 1 || p.leased || !p.claim {
		t.Fatal("cleanup proof or permanent fence lost")
	}
	if strings.Contains(string(p.raw), "fixture private prompt") || strings.Contains(string(p.raw), "fixture private answer") {
		t.Fatal("private body persisted")
	}
	if err := old.WithCurrent(context.Background(), func(value *port.CurrentTurn) error {
		if value != nil {
			t.Fatal("historical positive current")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Ordinary construction never infers retirement from these bytes.
	if _, err := claimFixture(t, p); !errors.Is(err, Refused) {
		t.Fatal("generic reopen inferred authority", err)
	}
	next := port.JournalScope{ProfileID: "profile", BackendGeneration: "next"}
	newRepo, err := successorFixture(p, proof, next, r.owner.limits)
	if err != nil {
		t.Fatal(err)
	}
	newOwner, err := app.New(context.Background(), next, app.Dependencies{Gate: gate.New(), Journal: newRepo})
	if err != nil {
		t.Fatal(err)
	}
	freshRecord, err := decode(p.raw, r.owner.limits)
	if err != nil || freshRecord.Retirement != nil || len(freshRecord.Writes) != 0 || len(freshRecord.Incarnations) != 2 {
		t.Fatal("history restored as live state", freshRecord, err)
	}
	if _, err := newOwner.Admit(context.Background(), binding(), digest); !errors.Is(err, app.Mismatch) {
		t.Fatal("old incarnation admitted", err)
	}
	b := binding()
	b.BackendGeneration = "next"
	b.OperationID = "new-operation"
	b.TurnID = "new-turn"
	b.TurnGeneration++
	current, err := newOwner.Admit(context.Background(), b, digest)
	if err != nil || current == nil {
		t.Fatal(current, err)
	}
	if err := current.WithCurrent(context.Background(), func(value *port.CurrentTurn) error {
		if value == nil || value.Binding != b {
			t.Fatal("missing new live admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := successorFixture(p, proof, port.JournalScope{ProfileID: "profile", BackendGeneration: "third"}, r.owner.limits); !errors.Is(err, Refused) {
		t.Fatal("proof reused concurrently", err)
	}
	if err := newRepo.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := successorFixture(p, proof, port.JournalScope{ProfileID: "profile", BackendGeneration: "third"}, r.owner.limits); !errors.Is(err, Refused) {
		t.Fatal("consumed publication proof reused", err)
	}
}

func TestRetirementPublicationLostReplyCancellationOrCloseUnknownStayFenced(t *testing.T) {
	for _, fault := range []string{"reply", "cancel", "close"} {
		t.Run(fault, func(t *testing.T) {
			r, p, s, h := liveFixture(t, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "reply":
				p.replaceFault = true
			case "cancel":
				p.hook = cancel
			case "close":
				p.closeFault = true
			}
			if proof, err := s.Retire(ctx); proof != nil || !errors.Is(err, app.Unsettled) {
				t.Fatal("unknown retirement minted proof", proof, err)
			}
			stored, err := decode(p.raw, r.owner.limits)
			if err != nil || stored.Retirement == nil {
				t.Fatal("uncertain publication discarded", err)
			}
			replaces := p.replaces
			if _, err := r.Retire(context.Background(), *stored.Retirement); !errors.Is(err, Unknown) || p.replaces != replaces {
				t.Fatal("retirement replay", err)
			}
			if _, err := s.Retire(context.Background()); !errors.Is(err, app.Unsettled) || p.replaces != replaces {
				t.Fatal("owner retry", err)
			}
			if _, err := claimFixture(t, p); !errors.Is(err, Refused) {
				t.Fatal("unknown root bypassed", err)
			}
			if err := h.WithCurrent(context.Background(), func(value *port.CurrentTurn) error {
				if value == nil || value.Persistence != port.UnknownCommit {
					t.Fatal("unknown became absent/current")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRetirementCodecRequiresOriginalCommittedWitnessesAndCompleteRegistry(t *testing.T) {
	r, p, s, _ := liveFixture(t, true)
	if _, err := s.Retire(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*record){
		func(v *record) { v.Retirement.Turns = nil },
		func(v *record) { v.Retirement.Turns = []port.RetirementTurn{} },
		func(v *record) { v.Retirement.PreviousRevision++ },
		func(v *record) { v.Retirement.Root.Inode++ },
		func(v *record) { v.Retirement.Scope.BackendGeneration = "crossed" },
		func(v *record) { v.Retirement.Turns[0].AcknowledgedRevision = 0 },
		func(v *record) { v.Retirement.Turns[0].ReleasedRevision = 0 },
		func(v *record) { v.Retirement.Turns[0].Quiescence.Sequence = 2 },
		func(v *record) { v.Retirement.Turns[0].Quiescence.Binding.Document.DocumentGeneration++ },
		func(v *record) { v.Retirement.Turns[0].Quiescence.Confirmed = false },
		func(v *record) {
			for n := range v.Writes {
				if v.Writes[n].Entry.Kind == "settle" {
					v.Writes[n].Entry.Quiescence = turn.QuiescenceEvidence{}
				}
			}
		},
		func(v *record) { v.Version = 1 },
		func(v *record) { v.Incarnations = []string{scope.BackendGeneration, scope.BackendGeneration} },
	} {
		value, err := decode(p.raw, r.owner.limits)
		if err != nil {
			t.Fatal(err)
		}
		mutate(&value)
		if _, err := encode(value, r.owner.limits); err == nil {
			t.Fatal("invented or missing clean evidence accepted")
		}
	}
}

func TestFreshSuccessorLostReplyCannotUseOldRetirementProofAgain(t *testing.T) {
	r, p, s, _ := liveFixture(t, false)
	proof, err := s.Retire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	next := port.JournalScope{ProfileID: "profile", BackendGeneration: "next"}
	newRepo, err := successorFixture(p, proof, next, r.owner.limits)
	if err != nil {
		t.Fatal(err)
	}
	p.replaceFault = true
	if newOwner, err := app.New(context.Background(), next, app.Dependencies{Gate: gate.New(), Journal: newRepo}); newOwner != nil || !errors.Is(err, app.Unsettled) {
		t.Fatal("uncertain empty publication became live", newOwner, err)
	}
	if err := newRepo.Close(); err != nil {
		t.Fatal(err)
	}
	stored, err := decode(p.raw, r.owner.limits)
	if err != nil || stored.Scope != next || stored.Retirement != nil || len(stored.Writes) != 0 {
		t.Fatal("fresh unknown fence discarded", err)
	}
	p.replaceFault = false
	if _, err := successorFixture(p, proof, port.JournalScope{ProfileID: "profile", BackendGeneration: "third"}, r.owner.limits); !errors.Is(err, Refused) {
		t.Fatal("fresh scope cleared unknown publication", err)
	}
}

func TestExactRootPublicationAndIncarnationTombstonesRemainRequired(t *testing.T) {
	for _, mismatch := range []string{"root", "digest", "scope", "same-incarnation"} {
		t.Run(mismatch, func(t *testing.T) {
			r, p, s, _ := liveFixture(t, false)
			proof, err := s.Retire(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			known, err := captureProof(context.Background(), proof)
			if err != nil {
				t.Fatal(err)
			}
			next := port.JournalScope{ProfileID: "profile", BackendGeneration: "next"}
			switch mismatch {
			case "root":
				known.Write.Root.Inode++
			case "digest":
				known.PublicationDigest[0]++
			case "scope":
				next.ProfileID = "other"
			case "same-incarnation":
				next = scope
			}
			fixture := newOwner("profile", r.owner.limits, &fixtureStorage{root: p}, fixtureRoot)
			before := p.replaces
			if err := qualifySuccessor(context.Background(), fixture, next, known); !errors.Is(err, Refused) || p.replaces != before {
				t.Fatal("mismatched proof accepted", err)
			}
		})
	}
	limits := Limits{Bytes: 1024 * 1024, Records: 3}
	p := &physicalFixture{claim: true, leased: true}
	r := newOwner("profile", limits, &fixtureStorage{root: p}, fixtureRoot)
	s, err := app.New(context.Background(), scope, app.Dependencies{Gate: gate.New(), Journal: r})
	if err != nil {
		t.Fatal(err)
	}
	for _, generation := range []string{"second", "third"} {
		proof, err := s.Retire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		next := port.JournalScope{ProfileID: "profile", BackendGeneration: generation}
		r, err = successorFixture(p, proof, next, limits)
		if err != nil {
			t.Fatal(err)
		}
		s, err = app.New(context.Background(), next, app.Dependencies{Gate: gate.New(), Journal: r})
		if err != nil {
			t.Fatal(err)
		}
	}
	proof, err := s.Retire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := successorFixture(p, proof, port.JournalScope{ProfileID: "profile", BackendGeneration: "fourth"}, limits); !errors.Is(err, Refused) {
		t.Fatal("tombstones evicted", err)
	}
	stored, err := decode(p.raw, limits)
	if err != nil || len(stored.Incarnations) != 3 {
		t.Fatal("saturated evidence discarded", err)
	}
}

type invalidOrigin struct{ mode string }

func (p invalidOrigin) WithRetirement(ctx context.Context, inspect func(*port.RetirementReceipt) error) error {
	switch p.mode {
	case "unknown":
		return Unknown
	case "nil":
		return inspect(nil)
	case "twice":
		inspect(nil)
		return inspect(nil)
	}
	return nil
}

func TestCheapReopenOriginValidationNeverCallsNativeIO(t *testing.T) {
	next := port.JournalScope{ProfileID: "profile", BackendGeneration: "next"}
	root := Root{Path: "deliberately invalid", ProfileID: "profile", Device: 11, Inode: 23, OwnerUID: 501}
	for _, proof := range []port.CleanRetirement{nil, invalidOrigin{"unknown"}, invalidOrigin{"nil"}, invalidOrigin{"twice"}, invalidOrigin{"no-callback"}} {
		if r, err := NewAfterRetirement(context.Background(), root, next, Limits{Bytes: 1024, Records: 3}, proof); r != nil || err == nil {
			t.Fatal("invalid origin reached native constructor", r, err)
		}
	}
}

func TestCodecCannotRetireComputerCallErasedByTerminalProjection(t *testing.T) {
	p := &physicalFixture{}
	r, err := claimFixture(t, p)
	if err != nil {
		t.Fatal(err)
	}
	s, err := app.New(context.Background(), scope, app.Dependencies{Gate: gate.New(), Journal: r, Browser: exactBrowser{}, Results: exactResults{}, ResultBytesLimit: 1024})
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.Admit(context.Background(), binding(), digest)
	if err != nil {
		t.Fatal(err)
	}
	apply := func(c app.Change) *turn.Snapshot {
		t.Helper()
		v, err := s.Apply(context.Background(), h, c)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	apply(app.Change{Action: app.Enqueue})
	if _, err := s.PrepareNext(context.Background(), 1000); err != nil {
		t.Fatal(err)
	}
	view, err := s.Send(context.Background(), h, "fixture prompt", 1000, "send-failure")
	if err != nil {
		t.Fatal(err)
	}
	b := view.Binding
	apply(app.Change{Action: app.Accept, Binding: b})
	apply(app.Change{Action: app.RequestComputer, Binding: b, CallID: "unresolved"})
	if _, err := s.Finish(context.Background(), h, b, turn.Result{ID: "failure", Outcome: turn.Failed, Code: "FAILED"}, nil); err != nil {
		t.Fatal(err)
	}
	apply(app.Change{Action: app.Acknowledge, ResultID: "failure"})
	apply(app.Change{Action: app.Settle, Quiescence: turn.QuiescenceEvidence{Binding: b, ResultID: "failure", Sequence: 12, Confirmed: true}})
	apply(app.Change{Action: app.Release, Reservation: b.Reservation})
	if proof, err := s.Retire(context.Background()); proof != nil || !errors.Is(err, app.Unsettled) {
		t.Fatal("unresolved actual owner retired", err)
	}
	stored, err := decode(p.raw, r.owner.limits)
	if err != nil {
		t.Fatal(err)
	}
	retiring := port.RetirementTurn{Binding: binding()}
	for _, w := range stored.Writes {
		retiring.Snapshot = w.Entry.After
		switch w.Entry.Kind {
		case "acknowledge":
			retiring.AcknowledgedRevision = w.Revision
		case "settle":
			retiring.SettledRevision, retiring.Quiescence = w.Revision, w.Entry.Quiescence
		case "release":
			retiring.ReleasedRevision = w.Revision
		}
	}
	if retiring.Snapshot.OutstandingCallID != "" || !retiring.Snapshot.LifecycleSettled {
		t.Fatal("fixture does not exhibit erased projection")
	}
	before := p.replaces
	w := port.RetirementWrite{Scope: scope, Root: fixtureRoot, PreviousRevision: uint64(len(stored.Writes)), Revision: uint64(len(stored.Writes)) + 1, Turns: []port.RetirementTurn{retiring}}
	if receipt, err := r.Retire(context.Background(), w); receipt != nil || !errors.Is(err, Refused) || p.replaces != before {
		t.Fatal("codec forgot unresolved call", receipt, err)
	}
}

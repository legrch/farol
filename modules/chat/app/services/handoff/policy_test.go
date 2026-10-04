package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Memory ports qualify policy only, not native durability, processes or host ACK.
type memoryStore struct {
	guard  sync.Mutex
	fenced bool
	head   port.HandoffHead
	fault  string
	calls  int
	inside *bool
}

func (m *memoryStore) Load(context.Context) (*port.HandoffHead, error) {
	if m.inside != nil && *m.inside {
		panic("IO inside origin callback")
	}
	if m.fenced {
		return nil, Unknown
	}
	if m.head.Record == nil {
		return &port.HandoffHead{}, nil
	}
	r := Copy(*m.head.Record)
	return &port.HandoffHead{Record: &r, Digest: m.head.Digest}, nil
}
func (m *memoryStore) Publish(ctx context.Context, expected [32]byte, r port.HandoffRecord) (*port.HandoffHead, error) {
	if m.inside != nil && *m.inside {
		panic("IO inside origin callback")
	}
	m.calls++
	if expected != m.head.Digest {
		return nil, Refused
	}
	if err := ValidateTransition(m.head.Record, m.head.Digest, r); err != nil {
		return nil, err
	}
	digest, _ := Digest(r)
	r = Copy(r)
	m.head = port.HandoffHead{Record: &r, Digest: digest}
	switch m.fault {
	case "error":
		return nil, errors.New("lost publication")
	case "nil":
		return nil, nil
	case "digest":
		return &port.HandoffHead{Record: &r, Digest: [32]byte{}}, nil
	case "crossed-digest":
		return &port.HandoffHead{Record: &r, Digest: [32]byte{5}}, nil
	case "record":
		r.Origin = ""
		return &port.HandoffHead{Record: &r, Digest: digest}, nil
	case "cancel":
		if cancel, ok := ctx.Value(cancelKey{}).(context.CancelFunc); ok {
			cancel()
		}
	}
	return m.Load(ctx)
}

type cancelKey struct{}
type fixtureOrigin struct {
	receipt port.RetirementReceipt
	calls   int
	inside  *bool
}

func (o *fixtureOrigin) WithRetirement(_ context.Context, f func(*port.RetirementReceipt) error) error {
	if o.inside != nil {
		*o.inside = true
		defer func() { *o.inside = false }()
	}
	o.calls++
	r := o.receipt
	r.Write = port.CopyRetirement(r.Write)
	return f(&r)
}
func binding() port.HandoffBinding {
	return port.HandoffBinding{ProfileID: "profile", BackendGeneration: "generation-1", BuildID: "build", HostLifetimeID: "host-1", ChildLaunchID: "child-1", ParentRoot: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}, ChatRoot: port.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}}
}
func receipt(b port.HandoffBinding) port.RetirementReceipt {
	return port.RetirementReceipt{Write: port.RetirementWrite{Scope: port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, Root: b.ChatRoot, PreviousRevision: 0, Revision: 1, Turns: []port.RetirementTurn{}}, PublicationDigest: [32]byte{7}}
}

// Value fixture for hostile receipt sensitivity, not an actual retirement proof.
func cancelledReceipt(b port.HandoffBinding) port.RetirementReceipt {
	r := receipt(b)
	fixed := port.TurnBinding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 1}
	identity := turn.Identity{ProfileID: fixed.ProfileID, OwnerID: fixed.OwnerID, SessionID: fixed.SessionID, TaskID: fixed.TaskID, TurnID: fixed.TurnID, OperationID: fixed.OperationID, Generation: fixed.TurnGeneration}
	r.Write.PreviousRevision, r.Write.Revision = 3, 4
	r.Write.Turns = []port.RetirementTurn{{Binding: fixed, AcknowledgedRevision: 3, Snapshot: turn.Snapshot{Identity: identity, Phase: turn.Cancelled, HasResult: true, Result: turn.Result{ID: "result", Outcome: turn.CancelledOutcome, Code: "NOT_DISPATCHED"}, DeliveryAcknowledged: true, LifecycleSettled: true}}}
	return r
}

func TestNeverDispatchedReceiptRejectsEachBoundaryBeforePublication(t *testing.T) {
	mutations := map[string]func(*port.RetirementTurn){
		"profile":                 func(r *port.RetirementTurn) { r.Binding.ProfileID = "other" },
		"backend":                 func(r *port.RetirementTurn) { r.Binding.BackendGeneration = "other" },
		"owner":                   func(r *port.RetirementTurn) { r.Binding.OwnerID = ""; r.Snapshot.Identity.OwnerID = "" },
		"session":                 func(r *port.RetirementTurn) { r.Binding.SessionID = ""; r.Snapshot.Identity.SessionID = "" },
		"task":                    func(r *port.RetirementTurn) { r.Binding.TaskID = ""; r.Snapshot.Identity.TaskID = "" },
		"participant":             func(r *port.RetirementTurn) { r.Binding.ParticipantID = "" },
		"turn":                    func(r *port.RetirementTurn) { r.Binding.TurnID = ""; r.Snapshot.Identity.TurnID = "" },
		"operation":               func(r *port.RetirementTurn) { r.Binding.OperationID = ""; r.Snapshot.Identity.OperationID = "" },
		"generation":              func(r *port.RetirementTurn) { r.Binding.TurnGeneration = 0; r.Snapshot.Identity.Generation = 0 },
		"identity-profile":        func(r *port.RetirementTurn) { r.Snapshot.Identity.ProfileID = "other" },
		"identity-owner":          func(r *port.RetirementTurn) { r.Snapshot.Identity.OwnerID = "other" },
		"identity-session":        func(r *port.RetirementTurn) { r.Snapshot.Identity.SessionID = "other" },
		"identity-task":           func(r *port.RetirementTurn) { r.Snapshot.Identity.TaskID = "other" },
		"identity-turn":           func(r *port.RetirementTurn) { r.Snapshot.Identity.TurnID = "other" },
		"identity-operation":      func(r *port.RetirementTurn) { r.Snapshot.Identity.OperationID = "other" },
		"identity-generation":     func(r *port.RetirementTurn) { r.Snapshot.Identity.Generation++ },
		"not-closed-phase":        func(r *port.RetirementTurn) { r.Snapshot.Phase = turn.Admitted },
		"unknown-phase":           func(r *port.RetirementTurn) { r.Snapshot.Phase = turn.Unknown },
		"delivered-phase":         func(r *port.RetirementTurn) { r.Snapshot.Phase = turn.Delivered },
		"reserved":                func(r *port.RetirementTurn) { r.Snapshot.Reserved = true },
		"stale-reservation":       func(r *port.RetirementTurn) { r.Snapshot.Reservation.Ordinal = 1 },
		"bound":                   func(r *port.RetirementTurn) { r.Snapshot.Bound = true },
		"stale-binding":           func(r *port.RetirementTurn) { r.Snapshot.Binding.Reservation.Ordinal = 1 },
		"provider-home":           func(r *port.RetirementTurn) { r.Snapshot.Binding.Document.ProviderState = turn.ProviderHome },
		"provider-conversation":   func(r *port.RetirementTurn) { r.Snapshot.Binding.Document.ConversationID = "conversation" },
		"send-intent":             func(r *port.RetirementTurn) { r.Snapshot.SendIntent = true },
		"accepted":                func(r *port.RetirementTurn) { r.Snapshot.Accepted = true },
		"delta":                   func(r *port.RetirementTurn) { r.Snapshot.DeltaCount = 1 },
		"sequence":                func(r *port.RetirementTurn) { r.Snapshot.LastSequence = 1 },
		"outstanding-call":        func(r *port.RetirementTurn) { r.Snapshot.OutstandingCallID = "call" },
		"missing-result":          func(r *port.RetirementTurn) { r.Snapshot.HasResult = false },
		"missing-result-id":       func(r *port.RetirementTurn) { r.Snapshot.Result.ID = "" },
		"unknown-outcome":         func(r *port.RetirementTurn) { r.Snapshot.Result.Outcome = turn.UnknownOutcome },
		"completed-outcome":       func(r *port.RetirementTurn) { r.Snapshot.Result.Outcome = turn.Completed },
		"wrong-code":              func(r *port.RetirementTurn) { r.Snapshot.Result.Code = "CANCEL_AFTER_SEND" },
		"unacknowledged":          func(r *port.RetirementTurn) { r.Snapshot.DeliveryAcknowledged = false },
		"unsettled":               func(r *port.RetirementTurn) { r.Snapshot.LifecycleSettled = false },
		"missing-ack-revision":    func(r *port.RetirementTurn) { r.AcknowledgedRevision = 0 },
		"early-ack-revision":      func(r *port.RetirementTurn) { r.AcknowledgedRevision = 2 },
		"retirement-ack-revision": func(r *port.RetirementTurn) { r.AcknowledgedRevision = 4 },
		"settled-revision":        func(r *port.RetirementTurn) { r.SettledRevision = 1 },
		"released-revision":       func(r *port.RetirementTurn) { r.ReleasedRevision = 2 },
		"quiescence":              func(r *port.RetirementTurn) { r.Quiescence.Confirmed = true },
		"stale-quiescence":        func(r *port.RetirementTurn) { r.Quiescence.ResultID = "result" },
		"disposal":                func(r *port.RetirementTurn) { r.Disposal.Confirmed = true },
		"stale-disposal":          func(r *port.RetirementTurn) { r.Disposal.ResultID = "result" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			b := binding()
			r := cancelledReceipt(b)
			mutate(&r.Write.Turns[0])
			m := &memoryStore{}
			s, _ := New(m)
			if p, err := s.Capture(context.Background(), b, "handoff", &fixtureOrigin{receipt: r}); p != nil || !errors.Is(err, Nonempty) || m.calls != 0 {
				t.Fatal("unsafe turn admitted or published", err)
			}
		})
	}
}

func TestNeverDispatchedReceiptIdentitySyntaxAndRevisionBounds(t *testing.T) {
	for _, name := range []string{"whitespace", "control", "invalid-utf8", "oversized", "missing-history", "short-history", "revision-gap", "overflow", "zero-digest", "scope", "root", "nil-turns"} {
		t.Run(name, func(t *testing.T) {
			b := binding()
			r := cancelledReceipt(b)
			switch name {
			case "whitespace":
				r.Write.Turns[0].Binding.ParticipantID = "bad id"
			case "control":
				r.Write.Turns[0].Binding.ParticipantID = "bad\x7f"
			case "invalid-utf8":
				r.Write.Turns[0].Binding.ParticipantID = string([]byte{255})
			case "oversized":
				r.Write.Turns[0].Binding.ParticipantID = strings.Repeat("x", 121)
			case "missing-history":
				r.Write.PreviousRevision, r.Write.Revision = 0, 1
			case "short-history":
				r.Write.PreviousRevision, r.Write.Revision = 2, 3
			case "revision-gap":
				r.Write.Revision++
			case "overflow":
				r.Write.PreviousRevision, r.Write.Revision = math.MaxUint64-1, math.MaxUint64
			case "zero-digest":
				r.PublicationDigest = [32]byte{}
			case "scope":
				r.Write.Scope.BackendGeneration = "other"
			case "root":
				r.Write.Root.Inode++
			case "nil-turns":
				r.Write.Turns = nil
			}
			m := &memoryStore{}
			s, _ := New(m)
			if p, err := s.Capture(context.Background(), b, "handoff", &fixtureOrigin{receipt: r}); p != nil || err == nil || m.calls != 0 {
				t.Fatal("invalid receipt admitted", err)
			}
		})
	}
}
func prepared(t *testing.T) (*Service, *memoryStore, port.HandoffPublication) {
	t.Helper()
	m := &memoryStore{}
	s, _ := New(m)
	b := binding()
	p, err := s.Capture(context.Background(), b, "handoff-1", &fixtureOrigin{receipt: receipt(b)})
	if err != nil {
		t.Fatal(err)
	}
	return s, m, *p
}
func acknowledged(t *testing.T) (*Service, *memoryStore, port.HandoffPublication, [32]byte) {
	t.Helper()
	s, m, p := prepared(t)
	d, err := s.Acknowledge(context.Background(), port.HandoffACK{Publication: p})
	if err != nil {
		t.Fatal(err)
	}
	return s, m, p, d
}
func terminal(p port.HandoffPublication, d [32]byte) port.HandoffTerminal {
	zero := 0
	return port.HandoffTerminal{Publication: p, KnownACKDigest: d, Kind: port.HandoffNormalExit, StopMode: port.HandoffGracefulStop, ExitCode: &zero}
}
func terminated(t *testing.T) (*Service, *memoryStore, port.HandoffPublication) {
	t.Helper()
	s, m, p, d := acknowledged(t)
	if err := s.ObserveTerminal(context.Background(), terminal(p, d)); err != nil {
		t.Fatal(err)
	}
	return s, m, p
}
func consumption() port.HandoffConsumption {
	b := binding()
	b.BackendGeneration = "generation-2"
	b.HostLifetimeID = "host-2"
	b.ChildLaunchID = "child-2"
	return port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: port.JournalScope{ProfileID: "profile", BackendGeneration: "generation-2"}, AttemptID: "attempt-2", NextBinding: b}
}

func TestExactChainAndOneShotProof(t *testing.T) {
	s, m, p := terminated(t)
	next, err := s.Consume(context.Background(), p, consumption())
	if err != nil {
		t.Fatal(err)
	}
	if next.Scope != consumption().Next || m.head.Record.Stage != port.HandoffConsumed || m.calls != 4 {
		t.Fatal("missing durable consumption")
	}
	if _, err = s.Consume(context.Background(), p, consumption()); !errors.Is(err, Refused) {
		t.Fatal("consumption replay", err)
	}
	calls := 0
	if err = next.Proof.WithRetirement(context.Background(), func(r *port.RetirementReceipt) error {
		calls++
		if !port.SameRetirement(r.Write, receipt(binding()).Write) || r.PublicationDigest != p.ReceiptDigest {
			t.Fatal("origin changed")
		}
		r.Write.Scope.ProfileID = "mutated"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = next.Proof.WithRetirement(context.Background(), func(*port.RetirementReceipt) error { calls++; return nil }); !errors.Is(err, Refused) || calls != 1 {
		t.Fatal("proof replay", err)
	}
}
func TestProofFailureCannotReplay(t *testing.T) {
	s, _, p := terminated(t)
	next, err := s.Consume(context.Background(), p, consumption())
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("constructor failed")
	if err = next.Proof.WithRetirement(context.Background(), func(*port.RetirementReceipt) error { return sentinel }); err != sentinel {
		t.Fatal(err)
	}
	if err = next.Proof.WithRetirement(context.Background(), func(*port.RetirementReceipt) error { return nil }); err != Refused {
		t.Fatal("failed launch replay", err)
	}
}
func TestEachMissingEvidence(t *testing.T) {
	s, m, p := prepared(t)
	if err := s.ObserveTerminal(context.Background(), terminal(p, [32]byte{9})); err != Refused {
		t.Fatal("omitted ACK allowed", err)
	}
	if _, err := s.Consume(context.Background(), p, consumption()); err != Refused {
		t.Fatal("missing ACK/terminal allowed", err)
	}
	if m.calls != 1 {
		t.Fatal("refused operation performed IO")
	}
	s, m, p, d := acknowledged(t)
	if _, err := s.Consume(context.Background(), p, consumption()); err != Refused {
		t.Fatal("missing terminal allowed", err)
	}
	if d == ([32]byte{}) || m.calls != 2 {
		t.Fatal("ACK missing")
	}
	m.head.Record.Origin = ""
	m.head.Digest = [32]byte{8}
	if err := s.ObserveTerminal(context.Background(), terminal(p, d)); err != Unknown {
		t.Fatal("omitted origin allowed", err)
	}
}
func TestCaptureRejectsMissingOriginAndNonempty(t *testing.T) {
	for _, name := range []string{"nil-origin", "nil-turns", "nonempty-turns", "zero-digest", "scope", "root", "revision", "prior-history"} {
		t.Run(name, func(t *testing.T) {
			m := &memoryStore{}
			s, _ := New(m)
			b := binding()
			r := receipt(b)
			var o port.CleanRetirement
			switch name {
			case "nil-origin":
			case "nil-turns":
				r.Write.Turns = nil
			case "nonempty-turns":
				r.Write.Turns = []port.RetirementTurn{{}}
			case "zero-digest":
				r.PublicationDigest = [32]byte{}
			case "scope":
				r.Write.Scope.BackendGeneration = "other"
			case "root":
				r.Write.Root.Inode++
			case "revision":
				r.Write.Revision++
			case "prior-history":
				r.Write.PreviousRevision = 1
				r.Write.Revision = 2
			}
			if name != "nil-origin" {
				o = &fixtureOrigin{receipt: r}
			}
			if _, err := s.Capture(context.Background(), b, "handoff", o); err == nil || m.calls != 0 {
				t.Fatal("invalid origin admitted", err)
			}
		})
	}
}
func TestCrossedACKAndTerminal(t *testing.T) {
	mutations := map[string]func(*port.HandoffPublication){
		"profile": func(p *port.HandoffPublication) { p.Binding.ProfileID = "other" }, "parent-device": func(p *port.HandoffPublication) { p.Binding.ParentRoot.Device++ }, "parent-inode": func(p *port.HandoffPublication) { p.Binding.ParentRoot.Inode++ }, "parent-uid": func(p *port.HandoffPublication) { p.Binding.ParentRoot.OwnerUID++ }, "chat-device": func(p *port.HandoffPublication) { p.Binding.ChatRoot.Device++ }, "chat-inode": func(p *port.HandoffPublication) { p.Binding.ChatRoot.Inode++ }, "chat-uid": func(p *port.HandoffPublication) { p.Binding.ChatRoot.OwnerUID++ }, "generation": func(p *port.HandoffPublication) { p.Binding.BackendGeneration = "other" }, "build": func(p *port.HandoffPublication) { p.Binding.BuildID = "other" }, "host": func(p *port.HandoffPublication) { p.Binding.HostLifetimeID = "other" }, "child": func(p *port.HandoffPublication) { p.Binding.ChildLaunchID = "other" }, "handoff": func(p *port.HandoffPublication) { p.HandoffID = "other" }, "digest": func(p *port.HandoffPublication) { p.ReceiptDigest[0]++ },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s, m, p := prepared(t)
			bad := p
			mutate(&bad)
			if _, err := s.Acknowledge(context.Background(), port.HandoffACK{Publication: bad}); err != Refused || m.calls != 1 {
				t.Fatal("crossed ACK", err)
			}
			d, err := s.Acknowledge(context.Background(), port.HandoffACK{Publication: p})
			if err != nil {
				t.Fatal(err)
			}
			if err = s.ObserveTerminal(context.Background(), terminal(bad, d)); err != Refused || m.calls != 2 {
				t.Fatal("crossed child", err)
			}
		})
	}
}
func TestTerminalRejectsUnknownSignalForcedAndBeforeKnownACK(t *testing.T) {
	for _, name := range []string{"signal", "exit1", "no-code", "kind", "stop-missing", "forced", "no-ACK", "crossed-ACK"} {
		t.Run(name, func(t *testing.T) {
			s, m, p, d := acknowledged(t)
			event := terminal(p, d)
			switch name {
			case "signal":
				event.Signal = "SIGTERM"
			case "exit1":
				n := 1
				event.ExitCode = &n
			case "no-code":
				event.ExitCode = nil
			case "kind":
				event.Kind = "EOF"
			case "stop-missing":
				event.StopMode = ""
			case "forced":
				event.StopMode = port.HandoffForcedStop
			case "no-ACK":
				event.KnownACKDigest = [32]byte{}
			case "crossed-ACK":
				event.KnownACKDigest[0]++
			}
			if err := s.ObserveTerminal(context.Background(), event); err == nil || m.calls != 2 {
				t.Fatal("unclean terminal admitted", err)
			}
		})
	}
}
func TestInvalidSuccessorAndReplay(t *testing.T) {
	for _, name := range []string{"old-generation", "missing-generation", "cross-profile", "missing-attempt"} {
		t.Run(name, func(t *testing.T) {
			s, m, p := terminated(t)
			c := consumption()
			switch name {
			case "old-generation":
				c.Next.BackendGeneration = p.Binding.BackendGeneration
			case "missing-generation":
				c.Next.BackendGeneration = ""
			case "cross-profile":
				c.Next.ProfileID = "other"
			case "missing-attempt":
				c.AttemptID = ""
			}
			if proof, err := s.Consume(context.Background(), p, c); err == nil || proof != nil || m.calls != 3 {
				t.Fatal("bad successor", err)
			}
		})
	}
}
func TestUncertainPublicationAtEveryStepIsSticky(t *testing.T) {
	for _, fault := range []string{"error", "nil", "digest", "record", "crossed-digest", "cancel"} {
		for _, stage := range []string{"capture", "ACK", "terminal", "consume"} {
			t.Run(fault+"/"+stage, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				ctx = context.WithValue(ctx, cancelKey{}, context.CancelFunc(cancel))
				m := &memoryStore{}
				s, _ := New(m)
				b := binding()
				p := port.HandoffPublication{}
				d := [32]byte{}
				if stage != "capture" {
					v, e := s.Capture(ctx, b, "handoff-1", &fixtureOrigin{receipt: receipt(b)})
					if e != nil {
						t.Fatal(e)
					}
					p = *v
				}
				if stage == "terminal" || stage == "consume" {
					var e error
					d, e = s.Acknowledge(ctx, port.HandoffACK{Publication: p})
					if e != nil {
						t.Fatal(e)
					}
				}
				if stage == "consume" {
					if e := s.ObserveTerminal(ctx, terminal(p, d)); e != nil {
						t.Fatal(e)
					}
				}
				m.fault = fault
				var err error
				switch stage {
				case "capture":
					_, err = s.Capture(ctx, b, "handoff-1", &fixtureOrigin{receipt: receipt(b)})
				case "ACK":
					_, err = s.Acknowledge(ctx, port.HandoffACK{Publication: p})
				case "terminal":
					err = s.ObserveTerminal(ctx, terminal(p, d))
				case "consume":
					var proof *Successor
					proof, err = s.Consume(ctx, p, consumption())
					if proof != nil {
						t.Fatal("unknown consumption minted proof")
					}
				}
				if err != Unknown {
					t.Fatal("unknown upgraded", err)
				}
				calls := m.calls
				m.fault = ""
				fresh, _ := New(m)
				if _, e := fresh.Consume(context.Background(), p, consumption()); e != Unknown {
					t.Fatal("uncertain bytes reopened", e)
				}
				if _, e := s.Capture(context.Background(), b, "new", &fixtureOrigin{receipt: receipt(b)}); e != Unknown || m.calls != calls {
					t.Fatal("sticky uncertainty retried", e)
				}
			})
		}
	}
}
func TestNextCaptureRequiresConsumedGeneration(t *testing.T) {
	s, m, p := terminated(t)
	if _, err := s.Consume(context.Background(), p, consumption()); err != nil {
		t.Fatal(err)
	}
	b := binding()
	b.HostLifetimeID = "host-2"
	b.ChildLaunchID = "child-2"
	if _, err := s.Capture(context.Background(), b, "handoff-2", &fixtureOrigin{receipt: receipt(b)}); err != Refused {
		t.Fatal("old generation origin", err)
	}
	b.BackendGeneration = "generation-2"
	if _, err := s.Capture(context.Background(), b, "handoff-2", &fixtureOrigin{receipt: receipt(b)}); err != nil || m.head.Record.Stage != port.HandoffCaptured {
		t.Fatal("matching actual successor refused", err)
	}
}

// Use actual live Service.Retire; journal remains a CPU fixture. This protects
// the origin callback/no-IO boundary without implying native qualification.
type trackingGate struct {
	sync.Mutex
	inside bool
}

func (g *trackingGate) Lock()   { g.Mutex.Lock(); g.inside = true }
func (g *trackingGate) Unlock() { g.inside = false; g.Mutex.Unlock() }

type liveJournal struct{ root port.JournalRoot }

func (j liveJournal) OpenFresh(_ context.Context, s port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Root: j.root, Scope: s}, nil
}
func (j liveJournal) Commit(context.Context, port.JournalWrite) (*port.JournalReceipt, error) {
	return nil, errors.New("unused")
}
func (j liveJournal) Retire(_ context.Context, w port.RetirementWrite) (*port.RetirementReceipt, error) {
	return &port.RetirementReceipt{Write: port.CopyRetirement(w), PublicationDigest: [32]byte{7}}, nil
}

// Deterministic exact-reply journal, without native durability qualification.
type withdrawalJournal struct {
	liveJournal
	writes       []port.JournalWrite
	failRevision uint64
}

func (j *withdrawalJournal) Commit(_ context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if w.PreviousRevision != uint64(len(j.writes)) || w.Revision != w.PreviousRevision+1 {
		return nil, errors.New("crossed fixture revision")
	}
	j.writes = append(j.writes, w)
	if w.Revision == j.failRevision {
		return nil, errors.New("lost fixture reply")
	}
	return &port.JournalReceipt{Write: w}, nil
}

func TestActualWithdrawReadIntentRetireAndHandoff(t *testing.T) {
	for _, name := range []string{"read", "multiple", "queued-cancel"} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			b := binding()
			g := &trackingGate{}
			j := &withdrawalJournal{liveJournal: liveJournal{root: b.ChatRoot}}
			actual, err := lifecycle.New(ctx, receipt(b).Write.Scope, lifecycle.Dependencies{Gate: g, Journal: j})
			if err != nil {
				t.Fatal(err)
			}
			fixed := cancelledReceipt(b).Write.Turns[0].Binding
			ids := []string{"operation"}
			if name == "multiple" {
				ids = []string{"operation-z", "operation-a"}
			}
			for _, id := range ids {
				fixed.OperationID, fixed.TurnID = id, id
				h, err := actual.Admit(ctx, fixed, strings.Repeat("a", 64))
				if err != nil {
					t.Fatal(err)
				}
				if name == "queued-cancel" {
					if _, err := actual.Apply(ctx, h, lifecycle.Change{Action: lifecycle.Enqueue}); err != nil {
						t.Fatal(err)
					}
					if _, err := actual.Cancel(ctx, h, "result"); err != nil {
						t.Fatal(err)
					}
					if _, err := actual.Apply(ctx, h, lifecycle.Change{Action: lifecycle.Acknowledge, ResultID: "result"}); err != nil {
						t.Fatal(err)
					}
				} else if err := actual.WithdrawReadIntent(ctx, h); err != nil {
					t.Fatal(err)
				}
				if err := h.WithCurrent(ctx, func(c *port.CurrentTurn) error {
					if c != nil {
						t.Fatal("closed read remained current")
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			origin, err := actual.Retire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			m := &memoryStore{inside: &g.inside}
			s, _ := New(m)
			p, err := s.Capture(ctx, b, "handoff", origin)
			if err != nil {
				t.Fatal(err)
			}
			w := m.head.Record.Receipt.Write
			if len(w.Turns) != len(ids) || w.PreviousRevision != uint64(len(j.writes)) {
				t.Fatal("actual turns/history lost")
			}
			for _, retired := range w.Turns {
				entry := j.writes[retired.AcknowledgedRevision-1].Entry
				if entry.Kind != "acknowledge" || !entry.Closed || entry.Binding != retired.Binding || entry.After != retired.Snapshot {
					t.Fatal("ACK revision is not exact original transition")
				}
			}
			d, err := s.Acknowledge(ctx, port.HandoffACK{Publication: *p})
			if err != nil {
				t.Fatal(err)
			}
			// Terminal and host drain are explicit fixtures, not process evidence.
			if err := s.ObserveTerminal(ctx, terminal(*p, d)); err != nil {
				t.Fatal(err)
			}
			next, err := s.Consume(ctx, *p, consumption())
			if err != nil {
				t.Fatal(err)
			}
			if err := next.Proof.WithRetirement(ctx, func(r *port.RetirementReceipt) error {
				if !port.SameRetirement(r.Write, w) {
					t.Fatal("consumed proof lost original receipt")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := next.Proof.WithRetirement(ctx, func(*port.RetirementReceipt) error { t.Fatal("proof replay callback"); return nil }); !errors.Is(err, Refused) {
				t.Fatal("proof replay", err)
			}
			if _, err := s.Consume(ctx, *p, consumption()); !errors.Is(err, Refused) {
				t.Fatal("consumption replay", err)
			}
		})
	}
}

func TestActualUnknownWithdrawalCannotSupplyHandoffOrigin(t *testing.T) {
	for _, revision := range []uint64{2, 3} {
		t.Run(map[uint64]string{2: "cancel", 3: "ACK"}[revision], func(t *testing.T) {
			ctx := context.Background()
			b := binding()
			j := &withdrawalJournal{liveJournal: liveJournal{root: b.ChatRoot}, failRevision: revision}
			actual, err := lifecycle.New(ctx, receipt(b).Write.Scope, lifecycle.Dependencies{Gate: &sync.Mutex{}, Journal: j})
			if err != nil {
				t.Fatal(err)
			}
			h, err := actual.Admit(ctx, cancelledReceipt(b).Write.Turns[0].Binding, strings.Repeat("a", 64))
			if err != nil {
				t.Fatal(err)
			}
			if err := actual.WithdrawReadIntent(ctx, h); err == nil {
				t.Fatal("unknown withdrawal succeeded")
			}
			origin, err := actual.Retire(ctx)
			if origin != nil || !errors.Is(err, lifecycle.Unsettled) {
				t.Fatal("unknown minted origin", err)
			}
			m := &memoryStore{}
			s, _ := New(m)
			if p, err := s.Capture(ctx, b, "handoff", origin); p != nil || err == nil || m.calls != 0 {
				t.Fatal("unknown origin captured", err)
			}
			if uint64(len(j.writes)) != revision {
				t.Fatal("unknown journal retried")
			}
		})
	}
}

func TestNeverDispatchedRegistryOrderUniquenessAndEveryTurn(t *testing.T) {
	b := binding()
	r := cancelledReceipt(b)
	first := r.Write.Turns[0]
	second := first
	first.Binding.OperationID, first.Binding.TurnID = "a", "a"
	first.Snapshot.Identity.OperationID, first.Snapshot.Identity.TurnID = "a", "a"
	second.Binding.OperationID, second.Binding.TurnID = "z", "z"
	second.Snapshot.Identity.OperationID, second.Snapshot.Identity.TurnID = "z", "z"
	second.AcknowledgedRevision = 6
	r.Write.PreviousRevision, r.Write.Revision = 6, 7
	r.Write.Turns = []port.RetirementTurn{first, second}
	for _, name := range []string{"valid", "unordered", "duplicate-operation", "duplicate-logical-turn", "duplicate-ACK", "unsafe-second", "short-history"} {
		t.Run(name, func(t *testing.T) {
			bad := r
			bad.Write = port.CopyRetirement(r.Write)
			switch name {
			case "unordered":
				bad.Write.Turns[0], bad.Write.Turns[1] = bad.Write.Turns[1], bad.Write.Turns[0]
			case "duplicate-operation":
				bad.Write.Turns[1].Binding.OperationID = "a"
				bad.Write.Turns[1].Snapshot.Identity.OperationID = "a"
			case "duplicate-logical-turn":
				bad.Write.Turns[1].Binding.TurnID = "a"
				bad.Write.Turns[1].Snapshot.Identity.TurnID = "a"
			case "duplicate-ACK":
				bad.Write.Turns[1].AcknowledgedRevision = 3
			case "unsafe-second":
				bad.Write.Turns[1].Snapshot.SendIntent = true
			case "short-history":
				bad.Write.PreviousRevision, bad.Write.Revision = 5, 6
				bad.Write.Turns[1].AcknowledgedRevision = 5
			}
			m := &memoryStore{}
			s, _ := New(m)
			p, err := s.Capture(context.Background(), b, "handoff", &fixtureOrigin{receipt: bad})
			if name == "valid" {
				if err != nil || p == nil || m.calls != 1 {
					t.Fatal("complete ordered turns refused", err)
				}
			} else if err == nil || p != nil || m.calls != 0 {
				t.Fatal("unsafe registry admitted", err)
			}
		})
	}
}

func TestNeverDispatchedRegistryCannotExceedLiveQueueCapacity(t *testing.T) {
	b := binding()
	r := cancelledReceipt(b)
	first := r.Write.Turns[0]
	r.Write.Turns = make([]port.RetirementTurn, turn.MaxRequests+1)
	for n := range r.Write.Turns {
		actual := first
		id := fmt.Sprintf("operation-%04d", n)
		actual.Binding.OperationID, actual.Binding.TurnID = id, id
		actual.Snapshot.Identity.OperationID, actual.Snapshot.Identity.TurnID = id, id
		actual.AcknowledgedRevision = 3 * (uint64(n) + 1)
		r.Write.Turns[n] = actual
	}
	r.Write.PreviousRevision = 3 * uint64(len(r.Write.Turns))
	r.Write.Revision = r.Write.PreviousRevision + 1
	m := &memoryStore{}
	s, _ := New(m)
	if p, err := s.Capture(context.Background(), b, "handoff", &fixtureOrigin{receipt: r}); p != nil || !errors.Is(err, Nonempty) || m.calls != 0 {
		t.Fatal("impossible live registry admitted", err)
	}
}

func TestNeverDispatchedHandoffKeepsHostAndSuccessorFences(t *testing.T) {
	for _, name := range []string{"before-ACK", "crossed-ACK", "unknown-terminal", "forced-stop", "cross-build", "missing-drain", "old-host", "old-child", "cross-root", "receipt-change"} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			b := binding()
			origin := &fixtureOrigin{receipt: cancelledReceipt(b)}
			m := &memoryStore{}
			s, _ := New(m)
			p, err := s.Capture(ctx, b, "handoff", origin)
			if err != nil {
				t.Fatal(err)
			}
			if name == "before-ACK" {
				if err := s.ObserveTerminal(ctx, terminal(*p, [32]byte{1})); !errors.Is(err, Refused) || m.calls != 1 {
					t.Fatal("missing host ACK accepted", err)
				}
				return
			}
			d, err := s.Acknowledge(ctx, port.HandoffACK{Publication: *p})
			if err != nil {
				t.Fatal(err)
			}
			if name == "receipt-change" {
				bad := Copy(*m.head.Record)
				bad.Stage = port.HandoffTerminated
				event := terminal(*p, d)
				bad.Terminal = &event
				bad.Receipt.Write.Turns[0].Binding.TaskEpoch++
				if err := ValidateRecord(bad); err != nil {
					t.Fatal("fixture must otherwise be admissible", err)
				}
				if err := ValidateTransition(m.head.Record, d, bad); !errors.Is(err, Refused) {
					t.Fatal("original receipt replaced", err)
				}
				return
			}
			event := terminal(*p, d)
			switch name {
			case "crossed-ACK":
				event.KnownACKDigest[0]++
			case "unknown-terminal":
				event.Kind = "EOF"
			case "forced-stop":
				event.StopMode = port.HandoffForcedStop
			}
			if name == "crossed-ACK" || name == "unknown-terminal" || name == "forced-stop" {
				if err := s.ObserveTerminal(ctx, event); err == nil || m.calls != 2 {
					t.Fatal("unclean terminal accepted", err)
				}
				return
			}
			if err := s.ObserveTerminal(ctx, event); err != nil {
				t.Fatal(err)
			}
			c := consumption()
			switch name {
			case "cross-build":
				c.NextBinding.BuildID = "other"
			case "missing-drain":
				c.PreviousHostDrainConfirmed = false
			case "old-host":
				c.NextBinding.HostLifetimeID = b.HostLifetimeID
			case "old-child":
				c.NextBinding.ChildLaunchID = b.ChildLaunchID
			case "cross-root":
				c.NextBinding.ChatRoot.Inode++
			}
			if next, err := s.Consume(ctx, *p, c); next != nil || !errors.Is(err, Refused) || m.calls != 3 {
				t.Fatal("unsafe successor accepted", err)
			}
		})
	}
}
func TestActualLiveRetireCopiesBeforePersistence(t *testing.T) {
	b := binding()
	g := &trackingGate{}
	actual, err := lifecycle.New(context.Background(), port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, lifecycle.Dependencies{Gate: g, Journal: liveJournal{root: b.ChatRoot}})
	if err != nil {
		t.Fatal(err)
	}
	proof, err := actual.Retire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := &memoryStore{inside: &g.inside}
	s, _ := New(m)
	if _, err = s.Capture(context.Background(), b, "handoff", proof); err != nil {
		t.Fatal(err)
	}
	if m.head.Record.Receipt.Write.Turns == nil || len(m.head.Record.Receipt.Write.Turns) != 0 {
		t.Fatal("lost actual explicit empty registry")
	}
}

func (m *memoryStore) Guard() port.Gate { return &m.guard }
func Digest(r port.HandoffRecord) ([32]byte, error) {
	if err := ValidateRecord(r); err != nil {
		return [32]byte{}, err
	}
	raw, e := json.Marshal(r)
	return sha256.Sum256(raw), e
}

func (m *memoryStore) Digest(r port.HandoffRecord) ([32]byte, error) { return Digest(r) }
func TestSuccessorRequiresExactNewHostAndSameBuild(t *testing.T) {
	for _, name := range []string{"missing-binding", "old-host", "old-child", "cross-build", "cross-parent", "cross-chat", "cross-generation"} {
		t.Run(name, func(t *testing.T) {
			s, m, p := terminated(t)
			c := consumption()
			switch name {
			case "missing-binding":
				c.NextBinding = port.HandoffBinding{}
			case "old-host":
				c.NextBinding.HostLifetimeID = p.Binding.HostLifetimeID
			case "old-child":
				c.NextBinding.ChildLaunchID = p.Binding.ChildLaunchID
			case "cross-build":
				c.NextBinding.BuildID = "other"
			case "cross-parent":
				c.NextBinding.ParentRoot.Inode++
			case "cross-chat":
				c.NextBinding.ChatRoot.Inode++
			case "cross-generation":
				c.NextBinding.BackendGeneration = "other"
			}
			if proof, err := s.Consume(context.Background(), p, c); err == nil || proof != nil || m.calls != 3 {
				t.Fatal("crossed next binding admitted", err)
			}
		})
	}
}

// These direct owning checks are mutation-sensitive: removing the origin or ACK
// requirement alone makes its corresponding regression fail.
func TestClosedRecordRequiresOriginAndACK(t *testing.T) {
	_, m, _ := prepared(t)
	r := Copy(*m.head.Record)
	r.Stage = port.HandoffAcknowledged
	r.ACK = &port.HandoffACK{Publication: r.Publication}
	if err := ValidateRecord(r); err != nil {
		t.Fatal(err)
	}
	t.Run("origin", func(t *testing.T) {
		bad := Copy(r)
		bad.Origin = ""
		if err := ValidateRecord(bad); err == nil {
			t.Fatal("missing origin accepted")
		}
	})
	t.Run("ACK", func(t *testing.T) {
		bad := Copy(r)
		bad.ACK = nil
		if err := ValidateRecord(bad); err == nil {
			t.Fatal("missing initiating host ACK accepted")
		}
	})
}

func (m *memoryStore) Fence(context.Context) error { m.fenced = true; return nil }

func TestPersistedTerminalCannotReplaceIndependentHostDrainWitness(t *testing.T) {
	_, disk, publication := terminated(t)
	// Recorder bytes survive, but its result was lost before trusted host drain.
	// A fresh service sees valid-looking terminal without any UNKNOWN marker.
	fresh, err := New(disk)
	if err != nil {
		t.Fatal(err)
	}
	attempt := consumption()
	attempt.PreviousHostDrainConfirmed = false
	if proof, err := fresh.Consume(context.Background(), publication, attempt); !errors.Is(err, Refused) || proof != nil {
		t.Fatal("unknown host completion minted successor", err)
	}
	if disk.calls != 3 {
		t.Fatal("unknown host completion appended")
	}
}

package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
	app "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
)

// All tests in this file are cheap storage-protocol fixtures, NOT native FS,
// atomic rename, cross-process locking, power-loss, race or boot qualification.
type physicalFixture struct {
	claim                                 bool
	raw                                   []byte
	creates, replaces, reads, closes      int
	createFault, replaceFault, closeFault bool
	hook                                  func()
}
type fixtureStorage struct{ root *physicalFixture }

func claimFixture(t *testing.T, p *physicalFixture) (*Repository, error) {
	t.Helper()
	if p.claim {
		return nil, failure(Refused, false)
	}
	p.claim = true
	return newOwner("profile", Limits{Bytes: 1024 * 1024, Records: 256}, &fixtureStorage{root: p}), nil
}
func (f *fixtureStorage) read(max int) ([]byte, error) {
	f.root.reads++
	if len(f.root.raw) == 0 || len(f.root.raw) > max {
		return nil, errors.New("fixture read failed")
	}
	return append([]byte(nil), f.root.raw...), nil
}
func (f *fixtureStorage) create(_ context.Context, raw []byte) error {
	p := f.root
	p.creates++
	if p.raw != nil {
		return failure(Refused, false)
	}
	p.raw = append([]byte(nil), raw...)
	if p.createFault {
		return failure(Unknown, true)
	}
	return nil
}
func (f *fixtureStorage) replace(_ context.Context, raw []byte, _ [32]byte) error {
	p := f.root
	p.replaces++
	p.raw = append([]byte(nil), raw...)
	if p.hook != nil {
		p.hook()
	}
	if p.replaceFault {
		return failure(Unknown, true)
	}
	return nil
}
func (f *fixtureStorage) close() error {
	f.root.closes++
	if f.root.closeFault {
		return errors.New("fixture close unknown")
	}
	return nil
}

var scope = port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}

const digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func binding() port.TurnBinding {
	return port.TurnBinding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 3}
}
func admissionWrite(t *testing.T) port.JournalWrite {
	t.Helper()
	b := binding()
	q, _ := turn.NewQueue(scope.ProfileID, scope.BackendGeneration)
	s, err := q.Admit(identity(b), digest)
	if err != nil {
		t.Fatal(err)
	}
	return port.JournalWrite{Scope: scope, Revision: 1, Entry: port.JournalEntry{Binding: b, Kind: "admit", IntentDigest: digest, After: s}}
}
func fresh(t *testing.T) (*Repository, *physicalFixture) {
	t.Helper()
	p := &physicalFixture{}
	r, err := claimFixture(t, p)
	if err != nil {
		t.Fatal(err)
	}
	h, err := r.OpenFresh(context.Background(), scope)
	if err != nil || h.Scope != scope || h.Revision != 0 {
		t.Fatal(h, err)
	}
	return r, p
}
func TestExactKnownCASAndRepositoryCopiesHaveOneOwner(t *testing.T) {
	r, p := fresh(t)
	copy := *r
	w := admissionWrite(t)
	receipt, err := copy.Commit(context.Background(), w)
	if err != nil || receipt.Write != w || p.replaces != 1 {
		t.Fatal(receipt, err)
	}
	if _, err := r.Commit(context.Background(), w); !errors.Is(err, Refused) || p.replaces != 1 {
		t.Fatal("duplicate replay", err)
	}
	if _, err := copy.Commit(context.Background(), w); !errors.Is(err, Refused) || p.replaces != 1 {
		t.Fatal("copy escaped sticky owner", err)
	}
}
func TestExistingClaimBlocksAllNewIncarnationsIncludingEmptyAndUnknown(t *testing.T) {
	for _, fault := range []bool{false, true} {
		p := &physicalFixture{createFault: fault}
		r, err := claimFixture(t, p)
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.OpenFresh(context.Background(), scope)
		if fault && !errors.Is(err, Unknown) {
			t.Fatal(err)
		}
		if err := r.Close(); err != nil {
			t.Fatal(err)
		}
		if newer, err := claimFixture(t, p); newer != nil || !errors.Is(err, Refused) {
			t.Fatal("new incarnation bypassed retained physical claim", newer, err)
		}
		if !p.claim || p.closes != 1 {
			t.Fatal("close retired persistent claim")
		}
	}
}
func TestScopeChangeCannotClaimOrCommitAnotherBackend(t *testing.T) {
	r, p := fresh(t)
	other := scope
	other.BackendGeneration = "new-backend"
	if _, err := r.OpenFresh(context.Background(), other); !errors.Is(err, Refused) || p.creates != 1 {
		t.Fatal("rebound scope", err)
	}
	r, p = fresh(t)
	w := admissionWrite(t)
	w.Scope = other
	if _, err := r.Commit(context.Background(), w); !errors.Is(err, Refused) || p.replaces != 0 {
		t.Fatal("cross-scope append", err)
	}
}
func TestPublicationBeforeLostReplyAndCancelledReplyStayUnknown(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		r, p := fresh(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		if cancelled {
			p.hook = cancel
		} else {
			p.replaceFault = true
		}
		w := admissionWrite(t)
		receipt, err := r.Commit(ctx, w)
		if receipt != nil || !errors.Is(err, Unknown) || p.replaces != 1 {
			t.Fatal("uncertain publication became known", receipt, err)
		}
		var classified *Failure
		if !errors.As(err, &classified) || !classified.OutcomeUnknown {
			t.Fatal("lost uncertainty", err)
		}
		if _, err := r.Commit(context.Background(), w); !errors.Is(err, Unknown) || p.replaces != 1 {
			t.Fatal("mutation retried", err)
		}
		retained, err := decode(p.raw, r.owner.limits)
		if err != nil || len(retained.Writes) != 1 {
			t.Fatal("publication evidence discarded", err)
		}
	}
}
func TestExternalBytesAndMetadataBoundsRefuseBeforePublication(t *testing.T) {
	r, p := fresh(t)
	p.raw = append(p.raw, ' ')
	if _, err := r.Commit(context.Background(), admissionWrite(t)); !errors.Is(err, Unavailable) || p.replaces != 0 {
		t.Fatal("external replacement accepted", err)
	}
	r, p = fresh(t)
	r.owner.limits.Records = 1
	w := admissionWrite(t)
	if _, err := r.Commit(context.Background(), w); err != nil {
		t.Fatal(err)
	}
	q, _ := turn.NewQueue(scope.ProfileID, scope.BackendGeneration)
	q.Admit(identity(binding()), digest)
	after, _ := q.Enqueue(identity(binding()))
	next := port.JournalWrite{Scope: scope, PreviousRevision: 1, Revision: 2, Entry: port.JournalEntry{Binding: binding(), Kind: "enqueue", Before: w.Entry.After, After: after}}
	if _, err := r.Commit(context.Background(), next); !errors.Is(err, Refused) || p.replaces != 1 {
		t.Fatal("record budget evicted evidence", err)
	}
	r, p = fresh(t)
	r.owner.limits.Bytes = len(p.raw)
	if _, err := r.Commit(context.Background(), w); !errors.Is(err, Refused) || p.replaces != 0 {
		t.Fatal("byte budget violated", err)
	}
}
func TestCloseDoesNotMaskUnknownDescriptorCleanup(t *testing.T) {
	r, p := fresh(t)
	p.closeFault = true
	if err := r.Close(); !errors.Is(err, Unavailable) {
		t.Fatal(err)
	}
	if err := r.Close(); !errors.Is(err, Unavailable) || p.closes != 1 || !p.claim {
		t.Fatal("unknown close retried/masked", err)
	}
}
func TestRealOwnerPublishesHandleOnlyAfterAdapterKnownCommit(t *testing.T) {
	for _, lost := range []bool{false, true} {
		p := &physicalFixture{replaceFault: lost}
		r, err := claimFixture(t, p)
		if err != nil {
			t.Fatal(err)
		}
		s, err := app.New(context.Background(), scope, app.Dependencies{Gate: gate.New(), Journal: r})
		if err != nil {
			t.Fatal(err)
		}
		h, err := s.Admit(context.Background(), binding(), digest)
		if lost {
			if h != nil || !errors.Is(err, app.Unsettled) {
				t.Fatal("owner minted uncertain admission", h, err)
			}
			continue
		}
		if err != nil || h == nil {
			t.Fatal(h, err)
		}
		projection, err := admissionsvc.New(h)
		if err != nil {
			t.Fatal(err)
		}
		if err = projection.WithCurrent(context.Background(), func(b *admissionsvc.TaskBinding) error {
			if b == nil || b.TaskEpoch != 7 {
				t.Fatal("not actual current")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Cancel(context.Background(), h, "cancel"); err != nil {
			t.Fatal(err)
		}
		if err = projection.WithCurrent(context.Background(), func(b *admissionsvc.TaskBinding) error {
			if b != nil {
				t.Fatal("terminal still current")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		record, err := decode(p.raw, r.owner.limits)
		if err != nil || len(record.Writes) != 2 || record.Writes[1].Entry.Kind != "cancel" {
			t.Fatal("actual lifecycle not recorded", err)
		}
	}
}
func TestCodecCanonicalClosedMetadataAndNoBodyFields(t *testing.T) {
	limits := Limits{Bytes: 1024 * 1024, Records: 256}
	value := record{Version: 1, Scope: scope, Writes: []port.JournalWrite{admissionWrite(t)}}
	raw, err := encode(value, limits)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decode(raw, limits); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{append(append([]byte(nil), raw...), []byte(" {}")...), append(append([]byte(nil), raw...), byte(' ')), []byte(strings.Replace(string(raw), "\"version\":1", "\"version\":1,\"version\":1", 1)), []byte(strings.Replace(string(raw), "\"version\":1", "\"version\":1,\"answer\":\"private answer\"", 1))} {
		if _, err := decode(bad, limits); err == nil {
			t.Fatal("ambiguous/unknown content accepted")
		}
	}
	var serialized map[string]any
	if json.Unmarshal(raw, &serialized) != nil || strings.Contains(string(raw), "private answer") || strings.Contains(string(raw), "Prompt") || strings.Contains(string(raw), "Payload") {
		t.Fatal("body field in metadata")
	}
	value.Writes[0].Entry.Binding.TaskEpoch++
	value.Writes[0].Entry.After.Identity.TaskID = "crossed"
	if _, err := encode(value, limits); err == nil {
		t.Fatal("identity mismatch accepted")
	}
}
func TestCheapConstructorValidationPerformsNoNativeIO(t *testing.T) {
	if r, err := New(nil, Root{}, Limits{}); r != nil || !errors.Is(err, Cancelled) {
		t.Fatal(r, err)
	}
	if r, err := New(context.Background(), Root{}, Limits{}); r != nil || !errors.Is(err, Invalid) {
		t.Fatal(r, err)
	}
}

// Browser/retention fixtures provide exact values only; no DOM/native IO occurs.
type exactBrowser struct{}

func (exactBrowser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	return &port.PrepareResponse{Readiness: port.Ready, Binding: port.BrowserBinding{Lease: r.Lease, ViewID: "view", ViewGeneration: 1, DocumentGeneration: 1, ConversationID: "conversation"}}, nil
}
func (exactBrowser) Send(r port.SendRequest) (*port.SendResponse, error) {
	return &port.SendResponse{Binding: r.Binding, Status: port.Submitted}, nil
}
func (exactBrowser) Observe(port.ObserveRequest) (*port.ObserveResponse, error) {
	panic("unused fixture")
}
func (exactBrowser) Cancel(port.CancelRequest) (*port.CancelResponse, error) { panic("unused fixture") }
func (exactBrowser) Dispose(port.DisposeRequest) (*port.DisposeResponse, error) {
	panic("unused fixture")
}

type exactResults struct{}

func (exactResults) Retain(_ context.Context, r port.RetainRequest) (*port.RetainReceipt, error) {
	return &port.RetainReceipt{Binding: r.Binding, Result: r.Result, Bytes: len(r.Payload)}, nil
}

func TestActualLifecycleTransactionsValidateThroughSlotRelease(t *testing.T) {
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
		view, err := s.Apply(context.Background(), h, c)
		if err != nil {
			t.Fatal(err)
		}
		return view
	}
	apply(app.Change{Action: app.Enqueue})
	if _, err = s.PrepareNext(context.Background(), 1000); err != nil {
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
	apply(app.Change{Action: app.AwaitOwner, Binding: b})
	apply(app.Change{Action: app.Resume, Binding: b})
	apply(app.Change{Action: app.Delta, Binding: b, Sequence: 1})
	if _, err = s.Finish(context.Background(), h, b, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("fixture private answer")); err != nil {
		t.Fatal(err)
	}
	apply(app.Change{Action: app.Acknowledge, ResultID: "result"})
	apply(app.Change{Action: app.Settle, Quiescence: turn.QuiescenceEvidence{Binding: b, ResultID: "result", Sequence: 2, Confirmed: true}})
	apply(app.Change{Action: app.Release, Reservation: b.Reservation})
	stored, err := decode(p.raw, r.owner.limits)
	if err != nil || len(stored.Writes) != 16 {
		t.Fatal("journal parity", len(stored.Writes), err)
	}
	if strings.Contains(string(p.raw), "fixture private prompt") || strings.Contains(string(p.raw), "fixture private answer") {
		t.Fatal("private body persisted")
	}
	// Validation reads can NEVER make an old journal fresh, even when all known
	// results have been acknowledged and slots released. Retirement is unowned.
	if _, err = r.OpenFresh(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "next"}); !errors.Is(err, Refused) {
		t.Fatal("implicit recovery invented", err)
	}
}

func TestMalformedTransitionsNeverPublishMetadata(t *testing.T) {
	for _, mutate := range []func(*port.JournalWrite){
		func(w *port.JournalWrite) { w.Revision = 2 },
		func(w *port.JournalWrite) { w.PreviousRevision = 1 },
		func(w *port.JournalWrite) { w.Entry.Kind = "unknown-kind" },
		func(w *port.JournalWrite) { w.Entry.Effect = "eval" },
		func(w *port.JournalWrite) { w.Entry.Closed = true },
		func(w *port.JournalWrite) { w.Entry.CallID = "irrelevant" },
		func(w *port.JournalWrite) { w.Entry.Binding.ParticipantID = "bad id" },
		func(w *port.JournalWrite) { w.Entry.After.Phase = turn.Running },
	} {
		r, p := fresh(t)
		w := admissionWrite(t)
		mutate(&w)
		if _, err := r.Commit(context.Background(), w); !errors.Is(err, Refused) || p.replaces != 0 {
			t.Fatal("invalid transition published", err)
		}
	}
}

func TestStickyFailureKeepsKnownRefusalSeparateFromUnknown(t *testing.T) {
	r, p := fresh(t)
	bad := admissionWrite(t)
	bad.Revision = 2
	firstErr := func() error { _, err := r.Commit(context.Background(), bad); return err }()
	_, again := r.Commit(context.Background(), admissionWrite(t))
	var f *Failure
	if firstErr != again || !errors.As(again, &f) || f.OutcomeUnknown || f.Code != Refused || p.replaces != 0 {
		t.Fatal("known refusal changed classification", firstErr, again)
	}
}

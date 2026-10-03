package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
	admissioncontract "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
)

// These are injected port fixtures around the REAL owner and Mutex gate. They
// prove source sequencing/races, not disk durability, DOM or native Computer IO.
type journalFixture struct {
	mu        sync.Mutex
	opened    bool
	scope     port.JournalScope
	writes    []port.JournalWrite
	hook      func(port.JournalWrite)
	fault     string
	openFault string
}

func (j *journalFixture) OpenFresh(_ context.Context, s port.JournalScope) (*port.JournalHead, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.opened {
		return nil, errors.New("fixture already owned")
	}
	j.opened, j.scope = true, s
	head := &port.JournalHead{Scope: s}
	switch j.openFault {
	case "error":
		return nil, errors.New("private fresh journal failure")
	case "nil":
		return nil, nil
	case "scope":
		head.Scope.ProfileID = "other"
	case "revision":
		head.Revision = 1
	}
	return head, nil
}
func (j *journalFixture) Commit(_ context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if j.hook != nil {
		j.hook(w)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if w.Scope != j.scope || w.PreviousRevision != uint64(len(j.writes)) || w.Revision != w.PreviousRevision+1 {
		return nil, errors.New("fixture CAS failed")
	}
	j.writes = append(j.writes, w) // publication-before-reply-loss window
	if j.fault == "error" {
		return nil, errors.New("private raw journal path")
	}
	if j.fault == "nil" {
		return nil, nil
	}
	reply := &port.JournalReceipt{Write: w}
	switch j.fault {
	case "revision":
		reply.Write.Revision++
	case "scope":
		reply.Write.Scope.BackendGeneration = "other"
	case "entry":
		reply.Write.Entry.After.Identity.TaskID = "other"
	}
	return reply, nil
}
func (j *journalFixture) count() int { j.mu.Lock(); defer j.mu.Unlock(); return len(j.writes) }

type browserFixture struct {
	mu                      sync.Mutex
	prepares, sends         int
	prepareHook             func(port.PrepareRequest)
	sendHook                func(port.SendRequest)
	prepareFault, sendFault string
}

func (b *browserFixture) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	b.mu.Lock()
	b.prepares++
	b.mu.Unlock()
	if b.prepareHook != nil {
		b.prepareHook(r)
	}
	reply := &port.PrepareResponse{Readiness: port.Ready, Binding: port.BrowserBinding{Lease: r.Lease, ViewID: fmt.Sprintf("view-%d", r.Lease.SlotOrdinal), ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: 1, ConversationID: "conversation-" + r.Lease.Identity.TaskID}}
	switch b.prepareFault {
	case "error":
		return nil, errors.New("private browser error")
	case "nil":
		return nil, nil
	case "lease":
		reply.Binding.Lease.SlotGeneration++
	case "document":
		reply.Binding.DocumentGeneration = 0
	case "owner":
		reply.Readiness = port.OwnerRequired
	case "sign-in":
		reply.Readiness = port.SignInRequired
	case "invalid":
		reply.Readiness = "invalid"
	}
	return reply, nil
}
func (b *browserFixture) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.mu.Lock()
	b.sends++
	b.mu.Unlock()
	if b.sendHook != nil {
		b.sendHook(r)
	}
	reply := &port.SendResponse{Binding: r.Binding, Status: port.Submitted}
	switch b.sendFault {
	case "error":
		return nil, errors.New("private browser error")
	case "nil":
		return nil, nil
	case "binding":
		reply.Binding.DocumentGeneration++
	case "not-sent":
		reply.Status = port.NotSent
	case "unknown":
		reply.Status = port.SendUnknown
	case "invalid":
		reply.Status = "invalid"
	}
	return reply, nil
}
func (*browserFixture) Observe(port.ObserveRequest) (*port.ObserveResponse, error) {
	panic("unused fixture capability")
}
func (*browserFixture) Cancel(port.CancelRequest) (*port.CancelResponse, error) {
	panic("unused fixture capability")
}
func (*browserFixture) Dispose(port.DisposeRequest) (*port.DisposeResponse, error) {
	panic("unused fixture capability")
}
func (b *browserFixture) counts() (int, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.prepares, b.sends
}

type resultFixture struct {
	calls   int
	hook    func(port.RetainRequest)
	fault   string
	payload []byte
}

func (r *resultFixture) Retain(_ context.Context, request port.RetainRequest) (*port.RetainReceipt, error) {
	r.calls++
	r.payload = append([]byte(nil), request.Payload...)
	if r.hook != nil {
		r.hook(request)
	}
	reply := &port.RetainReceipt{Binding: request.Binding, Result: request.Result, Bytes: len(request.Payload)}
	switch r.fault {
	case "error":
		return nil, errors.New("private retention failure")
	case "nil":
		return nil, nil
	case "binding":
		reply.Binding.TaskEpoch++
	case "result":
		reply.Result.ID = "other"
	case "bytes":
		reply.Bytes++
	}
	return reply, nil
}

const intentDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func route(n string) port.TurnBinding {
	return port.TurnBinding{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend", OwnerID: "owner", SessionID: "session", TaskID: "task-" + n, TaskEpoch: 17, ParticipantID: "participant-" + n, TurnID: "turn-" + n, OperationID: "operation-" + n, TurnGeneration: 3}
}
func owner(t *testing.T) (*Service, *journalFixture, *browserFixture, *resultFixture) {
	t.Helper()
	j, b, r := &journalFixture{}, &browserFixture{}, &resultFixture{}
	s, err := New(context.Background(), port.JournalScope{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend"}, Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: r, ResultBytesLimit: 256 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	return s, j, b, r
}
func admit(t *testing.T, s *Service, n string) *Handle {
	t.Helper()
	h, err := s.Admit(context.Background(), route(n), intentDigest)
	if err != nil {
		t.Fatal(err)
	}
	return h
}
func applyOK(t *testing.T, s *Service, h *Handle, c Change) *turn.Snapshot {
	t.Helper()
	view, err := s.Apply(context.Background(), h, c)
	if err != nil {
		t.Fatal(err)
	}
	return view
}
func current(t *testing.T, h *Handle) (*admissioncontract.TaskBinding, error) {
	t.Helper()
	service, err := admissionsvc.New(h)
	if err != nil {
		return nil, err
	}
	var got *admissioncontract.TaskBinding
	err = admissioncontract.New(service).WithCurrent(context.Background(), func(b *admissioncontract.TaskBinding) error { got = b; return nil })
	return got, err
}
func expectCurrent(t *testing.T, h *Handle, want bool) {
	t.Helper()
	got, err := current(t, h)
	if err != nil || (got != nil) != want {
		t.Fatalf("current=%+v err=%v want=%t", got, err, want)
	}
	if want && (got.OwnerID != h.fixed.OwnerID || got.TaskEpoch != h.fixed.TaskEpoch || got.ParticipantID != h.fixed.ParticipantID || got.TurnID != h.fixed.TurnID) {
		t.Fatal("fixed binding not preserved")
	}
}
func expectUnavailable(t *testing.T, h *Handle) {
	t.Helper()
	got, err := current(t, h)
	if err == nil || got != nil {
		t.Fatalf("positive from unsettled owner: %+v %v", got, err)
	}
	var f *admissioncontract.Failure
	if !errors.As(err, &f) || f.Code != "CHAT_ADMISSION_UNSETTLED" || f.Retry != "never" {
		t.Fatal("unsafe error", err)
	}
}
func prepared(t *testing.T, s *Service, h *Handle) turn.Binding {
	t.Helper()
	applyOK(t, s, h, Change{Action: Enqueue})
	if _, err := s.PrepareNext(context.Background(), 1000); err != nil {
		t.Fatal(err)
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		t.Fatal(err)
	}
	return view.Binding
}
func running(t *testing.T, s *Service, h *Handle) turn.Binding {
	t.Helper()
	b := prepared(t, s, h)
	if _, err := s.Send(context.Background(), h, "fixture private prompt", 1000, "send-result"); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Accept, Binding: b})
	applyOK(t, s, h, Change{Action: Delta, Binding: b, Sequence: 1})
	return b
}

func TestActualAdmissionMintsFixedHandleOnlyAfterKnownCommit(t *testing.T) {
	s, j, _, _ := owner(t)
	h := admit(t, s, "1")
	expectCurrent(t, h, true)
	if j.count() != 1 || s.revision != 1 {
		t.Fatal("admission not persisted")
	}
	if replay, err := s.Admit(context.Background(), route("1"), intentDigest); err != nil || replay != h || j.count() != 1 {
		t.Fatal("replay minted another owner", err)
	}
	changed := route("1")
	changed.TaskEpoch++
	if _, err := s.Admit(context.Background(), changed, intentDigest); !errors.Is(err, turn.Conflict) {
		t.Fatal("body epoch rebound admitted", err)
	}
	changed = route("1")
	changed.ParticipantID = "other"
	if _, err := s.Admit(context.Background(), changed, intentDigest); !errors.Is(err, turn.Conflict) {
		t.Fatal("participant rebound", err)
	}
	changed = route("2")
	changed.BackendGeneration = "other"
	if _, err := s.Admit(context.Background(), changed, intentDigest); !errors.Is(err, Mismatch) {
		t.Fatal("wrong incarnation", err)
	}
	if _, err := s.Admit(context.Background(), route("2"), "private body"); !errors.Is(err, turn.Invalid) {
		t.Fatal("invalid digest", err)
	}
	if j.count() != 1 {
		t.Fatal("invalid admission wrote journal")
	}
	if err := h.WithCurrent(context.Background(), func(c *port.CurrentTurn) error {
		c.Binding.TaskID = "mutated"
		c.Turn.Phase = turn.Delivered
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	expectCurrent(t, h, true)
	other, _, _, _ := owner(t)
	if _, err := other.Apply(context.Background(), h, Change{Action: Enqueue}); !errors.Is(err, Invalid) {
		t.Fatal("foreign handle accepted", err)
	}
	forged := *h
	if err := forged.WithCurrent(context.Background(), func(*port.CurrentTurn) error { t.Fatal("copied handle became authority"); return nil }); !errors.Is(err, Mismatch) {
		t.Fatal(err)
	}
}

func TestJournalPublicationBeforeLostReplyNeverMintsAdmission(t *testing.T) {
	for _, fault := range []string{"error", "nil", "revision", "scope", "entry"} {
		t.Run(fault, func(t *testing.T) {
			s, j, b, _ := owner(t)
			j.fault = fault
			h, err := s.Admit(context.Background(), route("1"), intentDigest)
			if h != nil || !errors.Is(err, Unsettled) || j.count() != 1 {
				t.Fatal("unknown admission", h, err)
			}
			if _, err := s.Admit(context.Background(), route("1"), intentDigest); !errors.Is(err, Unsettled) || j.count() != 1 {
				t.Fatal("journal retried", err)
			}
			if _, err := s.PrepareNext(context.Background(), 1000); !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			if prepares, sends := b.counts(); prepares != 0 || sends != 0 {
				t.Fatal("effect after uncertain journal")
			}
		})
	}
}

func TestPendingWriteWithdrawsBeforeIOAndLateCommitCannotUndoCancel(t *testing.T) {
	s, j, _, _ := owner(t)
	h := admit(t, s, "1")
	entered, release := make(chan struct{}), make(chan struct{})
	j.hook = func(w port.JournalWrite) {
		if w.Entry.Kind == "enqueue" {
			close(entered)
			<-release
		}
	}
	done := make(chan error, 1)
	go func() { _, err := s.Apply(context.Background(), h, Change{Action: Enqueue}); done <- err }()
	<-entered
	expectUnavailable(t, h)
	if view, err := s.queue.Snapshot(identity(h.fixed)); err != nil || view.Phase != turn.Admitted {
		t.Fatal("uncommitted candidate published", view, err)
	}
	if _, err := s.Apply(context.Background(), h, Change{Action: Enqueue}); !errors.Is(err, Busy) {
		t.Fatal("parallel journal writer", err)
	}
	if _, err := s.Cancel(context.Background(), h, "cancel"); !errors.Is(err, Unsettled) {
		t.Fatal("pending cancel became settled absence", err)
	}
	close(release)
	if err := <-done; !errors.Is(err, Unsettled) {
		t.Fatal("late commit won", err)
	}
	expectUnavailable(t, h)
	if j.count() != 2 || s.revision != 1 {
		t.Fatal("late commit changed live revision")
	}
	if _, err := s.Admit(context.Background(), route("1"), intentDigest); !errors.Is(err, Unsettled) {
		t.Fatal("rebound after revoke", err)
	}
}

func TestCompletionDuringPendingWriteFencesWithoutRetentionOrRetry(t *testing.T) {
	s, j, _, results := owner(t)
	h := admit(t, s, "1")
	b := running(t, s, h)
	entered, release := make(chan struct{}), make(chan struct{})
	j.hook = func(w port.JournalWrite) {
		if w.Entry.Kind == "delta" {
			close(entered)
			<-release
		}
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.Apply(context.Background(), h, Change{Action: Delta, Binding: b, Sequence: 2})
		done <- err
	}()
	<-entered
	if _, err := s.Finish(context.Background(), h, b, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("private answer")); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	if results.calls != 0 {
		t.Fatal("parallel result effect")
	}
	close(release)
	if err := <-done; !errors.Is(err, Unsettled) {
		t.Fatal("late delta resurrected completion", err)
	}
	expectUnavailable(t, h)
}

func TestCurrentCallbackSerializesEntireDisclosureAgainstCancel(t *testing.T) {
	s, j, _, _ := owner(t)
	h := admit(t, s, "1")
	service, _ := admissionsvc.New(h)
	contract := admissioncontract.New(service)
	entered, release := make(chan struct{}), make(chan struct{})
	readDone := make(chan error, 1)
	go func() {
		readDone <- contract.WithCurrent(context.Background(), func(b *admissioncontract.TaskBinding) error {
			if b == nil {
				return errors.New("missing current")
			}
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	started, cancelDone := make(chan struct{}), make(chan error, 1)
	go func() { close(started); _, err := s.Cancel(context.Background(), h, "cancel"); cancelDone <- err }()
	<-started
	if j.count() != 1 {
		t.Fatal("cancel persisted inside final disclosure")
	}
	select {
	case err := <-cancelDone:
		t.Fatal("cancel crossed gate", err)
	default:
	}
	close(release)
	if err := <-readDone; err != nil {
		t.Fatal(err)
	}
	if err := <-cancelDone; err != nil {
		t.Fatal(err)
	}
	expectCurrent(t, h, false)
	if _, err := s.Admit(context.Background(), route("1"), intentDigest); !errors.Is(err, turn.Conflict) {
		t.Fatal("closed handle rebound", err)
	}
}

func TestKnownCurrentEntryHasNoPortIOAndPreservesConsumerError(t *testing.T) {
	s, j, b, r := owner(t)
	h := admit(t, s, "1")
	j.hook = func(port.JournalWrite) { t.Fatal("journal IO in current gate") }
	b.prepareHook = func(port.PrepareRequest) { t.Fatal("browser IO in current gate") }
	r.hook = func(port.RetainRequest) { t.Fatal("retention IO in current gate") }
	consumer := errors.New("consumer policy")
	if err := h.WithCurrent(context.Background(), func(c *port.CurrentTurn) error {
		if c == nil {
			t.Fatal("missing current")
		}
		return consumer
	}); !errors.Is(err, consumer) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := h.WithCurrent(ctx, func(*port.CurrentTurn) error { t.Fatal("cancelled inspection"); return nil }); !errors.Is(err, Cancelled) {
		t.Fatal(err)
	}
}

func TestIntentCommitPrecedesEachEffectAndAdmissionRemainsWithdrawn(t *testing.T) {
	s, j, b, _ := owner(t)
	h := admit(t, s, "1")
	applyOK(t, s, h, Change{Action: Enqueue})
	b.prepareHook = func(r port.PrepareRequest) {
		expectUnavailable(t, h)
		if j.count() != 3 || j.writes[2].Entry.Effect != "prepare" || j.writes[2].Entry.After.Reservation != s.pending.entry.After.Reservation {
			t.Fatal("prepare before durable intent")
		}
		if r.Lease.Identity.TaskID != h.fixed.TaskID {
			t.Fatal("wrong lease")
		}
	}
	if _, err := s.PrepareNext(context.Background(), 1000); err != nil {
		t.Fatal(err)
	}
	expectCurrent(t, h, true)
	b.sendHook = func(r port.SendRequest) {
		expectUnavailable(t, h)
		last := j.writes[len(j.writes)-1]
		if last.Entry.Effect != "send" || !last.Entry.After.SendIntent || r.IntentDigest != intentDigest || r.Prompt != "fixture private prompt" {
			t.Fatal("send before durable exact intent")
		}
	}
	view, err := s.Send(context.Background(), h, "fixture private prompt", 1000, "lost-result")
	if err != nil || view.Phase != turn.Running || view.Accepted {
		t.Fatal("submitted equated with accepted", view, err)
	}
	expectCurrent(t, h, true)
	if _, err := s.Send(context.Background(), h, "fixture private prompt", 1000, "lost-result"); !errors.Is(err, turn.Transition) {
		t.Fatal("repeated send", err)
	}
	if _, sends := b.counts(); sends != 1 {
		t.Fatal("native Send repeated")
	}
}

func TestLostOrCrossedSendReplyIsStickyUnknownAndNeverResent(t *testing.T) {
	for _, fault := range []string{"error", "nil", "binding", "unknown", "invalid"} {
		t.Run(fault, func(t *testing.T) {
			s, j, b, _ := owner(t)
			h := admit(t, s, "1")
			binding := prepared(t, s, h)
			b.sendFault = fault
			view, err := s.Send(context.Background(), h, "private prompt", 1000, "unknown-result")
			if err != nil || view.Phase != turn.Unknown || view.Result.Outcome != turn.UnknownOutcome || !view.SendIntent {
				t.Fatal(view, err)
			}
			expectUnavailable(t, h)
			writes := j.count()
			if _, err := s.Send(context.Background(), h, "private prompt", 1000, "unknown-result"); !errors.Is(err, turn.Transition) {
				t.Fatal("retry allowed", err)
			}
			if _, err := s.Apply(context.Background(), h, Change{Action: Release, Reservation: binding.Reservation}); !errors.Is(err, turn.Unsettled) {
				t.Fatal(err)
			}
			if j.count() != writes {
				t.Fatal("retry wrote journal")
			}
			if _, sends := b.counts(); sends != 1 {
				t.Fatal("repeated native Send")
			}
		})
	}
}

func TestKnownNotSentRetainsFailureRatherThanInferringAcceptance(t *testing.T) {
	s, _, b, r := owner(t)
	h := admit(t, s, "1")
	prepared(t, s, h)
	b.sendFault = "not-sent"
	view, err := s.Send(context.Background(), h, "private prompt", 1000, "failure-result")
	if err != nil || view.Phase != turn.ResultReady || view.Result.Outcome != turn.Failed || r.calls != 1 {
		t.Fatal(view, err)
	}
	expectCurrent(t, h, false)
}

func TestRevokeDuringBrowserEffectRejectsLateSuccess(t *testing.T) {
	for _, operation := range []string{"prepare", "send"} {
		t.Run(operation, func(t *testing.T) {
			s, j, b, _ := owner(t)
			h := admit(t, s, "1")
			if operation == "send" {
				prepared(t, s, h)
			} else {
				applyOK(t, s, h, Change{Action: Enqueue})
			}
			entered, release := make(chan struct{}), make(chan struct{})
			if operation == "send" {
				b.sendHook = func(port.SendRequest) { close(entered); <-release }
			} else {
				b.prepareHook = func(port.PrepareRequest) { close(entered); <-release }
			}
			done := make(chan error, 1)
			go func() {
				var err error
				if operation == "send" {
					_, err = s.Send(context.Background(), h, "prompt", 1000, "lost")
				} else {
					_, err = s.PrepareNext(context.Background(), 1000)
				}
				done <- err
			}()
			<-entered
			writes := j.count()
			if _, err := s.Cancel(context.Background(), h, "cancel"); !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			close(release)
			if err := <-done; !errors.Is(err, Unsettled) {
				t.Fatal("late browser success restored current", err)
			}
			expectUnavailable(t, h)
			if j.count() != writes {
				t.Fatal("new IO after fenced effect")
			}
		})
	}
}

func TestJournalFailureStopsBrowserBeforeEffect(t *testing.T) {
	for _, operation := range []string{"prepare", "send"} {
		t.Run(operation, func(t *testing.T) {
			s, j, b, _ := owner(t)
			h := admit(t, s, "1")
			if operation == "send" {
				prepared(t, s, h)
			} else {
				applyOK(t, s, h, Change{Action: Enqueue})
			}
			prepares, sends := b.counts()
			j.fault = "error"
			var err error
			if operation == "send" {
				_, err = s.Send(context.Background(), h, "prompt", 1000, "lost")
			} else {
				_, err = s.PrepareNext(context.Background(), 1000)
			}
			if !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			p2, s2 := b.counts()
			if p2 != prepares || s2 != sends {
				t.Fatal("effect after unknown intent")
			}
			expectUnavailable(t, h)
		})
	}
}

func TestBadPrepareLeavesReservationFencedWithoutRepeat(t *testing.T) {
	for _, fault := range []string{"error", "nil", "lease", "document", "sign-in", "invalid"} {
		t.Run(fault, func(t *testing.T) {
			s, j, b, _ := owner(t)
			h := admit(t, s, "1")
			applyOK(t, s, h, Change{Action: Enqueue})
			b.prepareFault = fault
			if _, err := s.PrepareNext(context.Background(), 1000); !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			expectUnavailable(t, h)
			writes := j.count()
			if _, err := s.PrepareNext(context.Background(), 1000); !errors.Is(err, Unsettled) || j.count() != writes {
				t.Fatal("prepare retried", err)
			}
			if p, _ := b.counts(); p != 1 {
				t.Fatal("effect replayed")
			}
		})
	}
}

func TestFinishRetainsBeforePublicationAndMetadataNeverContainsText(t *testing.T) {
	s, j, _, r := owner(t)
	h := admit(t, s, "1")
	binding := running(t, s, h)
	result := turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}
	answer := []byte("private answer bytes")
	r.hook = func(request port.RetainRequest) {
		expectUnavailable(t, h)
		if request.Binding != h.fixed || request.Result != result || string(request.Payload) != string(answer) {
			t.Fatal("wrong retention scope")
		}
		request.Payload[0] = 'X' // port input cannot mutate caller bytes
	}
	view, err := s.Finish(context.Background(), h, binding, result, answer)
	if err != nil || view.Phase != turn.ResultReady || string(answer) != "private answer bytes" || string(r.payload) != "private answer bytes" {
		t.Fatal(view, err)
	}
	expectCurrent(t, h, false)
	writes := j.count()
	if _, err := s.Finish(context.Background(), h, binding, result, answer); !errors.Is(err, turn.Transition) || r.calls != 1 || j.count() != writes {
		t.Fatal("retention effect repeated", err)
	}
	data, err := json.Marshal(j.writes)
	if err != nil || strings.Contains(string(data), "fixture private prompt") || strings.Contains(string(data), "private answer bytes") {
		t.Fatal("private content retained in metadata", err)
	}
}

func TestUnknownRetentionCannotPublishTerminalAbsence(t *testing.T) {
	for _, fault := range []string{"error", "nil", "binding", "result", "bytes"} {
		t.Run(fault, func(t *testing.T) {
			s, j, _, r := owner(t)
			h := admit(t, s, "1")
			binding := running(t, s, h)
			r.fault = fault
			writes := j.count()
			if _, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("answer")); !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			if j.count() != writes {
				t.Fatal("published unknown retention")
			}
			expectUnavailable(t, h)
			if _, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("answer")); !errors.Is(err, Unsettled) || r.calls != 1 {
				t.Fatal("retention retried", err)
			}
		})
	}
}

func TestFiveViewsSixthWaitsAndReuseNeedsAckAndSettlement(t *testing.T) {
	s, _, browser, _ := owner(t)
	handles := make([]*Handle, 6)
	for n := range handles {
		handles[n] = admit(t, s, fmt.Sprint(n))
		applyOK(t, s, handles[n], Change{Action: Enqueue})
	}
	for n := 0; n < 5; n++ {
		if _, err := s.PrepareNext(context.Background(), 1000); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.PrepareNext(context.Background(), 1000); !errors.Is(err, turn.Capacity) {
		t.Fatal("sixth view allocated", err)
	}
	if p, _ := browser.counts(); p != 5 {
		t.Fatal("sixth native prepare")
	}
	h := handles[0]
	fixed := h.Binding()
	view, _ := s.queue.Snapshot(identity(fixed))
	binding := view.Binding
	if _, err := s.Send(context.Background(), h, "prompt", 1000, "failure"); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Accept, Binding: binding})
	applyOK(t, s, h, Change{Action: Delta, Binding: binding, Sequence: 1})
	if _, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("answer")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(context.Background(), h, Change{Action: Release, Reservation: binding.Reservation}); !errors.Is(err, turn.Unsettled) {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "result"})
	if _, err := s.Apply(context.Background(), h, Change{Action: Release, Reservation: binding.Reservation}); !errors.Is(err, turn.Unsettled) {
		t.Fatal("ACK alone released slot", err)
	}
	applyOK(t, s, h, Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: binding, ResultID: "result", Sequence: 2, Confirmed: true}})
	applyOK(t, s, h, Change{Action: Release, Reservation: binding.Reservation})
	next, err := s.PrepareNext(context.Background(), 1000)
	if err != nil || next.Lease.SlotOrdinal != binding.Reservation.Ordinal || next.Lease.SlotGeneration != binding.Reservation.Generation+1 || next.Lease.Identity.TaskID != handles[5].fixed.TaskID {
		t.Fatal(next, err)
	}
	if h.Binding() != fixed {
		t.Fatal("slot reuse changed durable route")
	}
	expectCurrent(t, h, false)
	if _, err := s.queue.ActiveBinding(identity(fixed)); !errors.Is(err, turn.NotFound) {
		t.Fatal("old route opened reused view", err)
	}
}

func TestOwnerRequiredAndComputerCallHistoryRemainDistinct(t *testing.T) {
	s, _, browser, _ := owner(t)
	h := admit(t, s, "1")
	browser.prepareFault = "owner"
	binding := prepared(t, s, h)
	expectCurrent(t, h, true)
	applyOK(t, s, h, Change{Action: Resume, Binding: binding})
	if _, err := s.Send(context.Background(), h, "prompt", 1000, "failed"); err != nil {
		t.Fatal(err)
	}
	applyOK(t, s, h, Change{Action: Accept, Binding: binding})
	applyOK(t, s, h, Change{Action: AwaitOwner, Binding: binding})
	expectCurrent(t, h, true)
	applyOK(t, s, h, Change{Action: Resume, Binding: binding})
	applyOK(t, s, h, Change{Action: RequestComputer, Binding: binding, CallID: "call"})
	if _, err := s.Apply(context.Background(), h, Change{Action: Delta, Binding: binding, Sequence: 1}); !errors.Is(err, turn.Transition) {
		t.Fatal("output crossed outstanding call", err)
	}
	applyOK(t, s, h, Change{Action: ResolveComputer, Binding: binding, CallID: "call"})
	if _, err := s.Apply(context.Background(), h, Change{Action: RequestComputer, Binding: binding, CallID: "call"}); !errors.Is(err, turn.Conflict) {
		t.Fatal("used call lost across candidates", err)
	}
}

func TestCancelBeforeAndAfterSendPreservesConservativeLifecycle(t *testing.T) {
	for _, sent := range []bool{false, true} {
		t.Run(fmt.Sprint(sent), func(t *testing.T) {
			s, _, _, _ := owner(t)
			h := admit(t, s, "1")
			binding := prepared(t, s, h)
			if sent {
				if _, err := s.Send(context.Background(), h, "prompt", 1000, "failure"); err != nil {
					t.Fatal(err)
				}
			}
			view, err := s.Cancel(context.Background(), h, "cancel")
			if err != nil {
				t.Fatal(err)
			}
			if sent {
				if view.Phase != turn.Unknown {
					t.Fatal(view)
				}
				expectUnavailable(t, h)
			} else {
				if view.Phase != turn.Cancelled || view.LifecycleSettled {
					t.Fatal(view)
				}
				expectCurrent(t, h, false)
				applyOK(t, s, h, Change{Action: Acknowledge, ResultID: "cancel"})
				applyOK(t, s, h, Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: binding, ResultID: "cancel", Sequence: 1, Confirmed: true}})
				applyOK(t, s, h, Change{Action: Release, Reservation: binding.Reservation})
			}
		})
	}
}

func TestCancelledJournalReplyAndRevisionExhaustionFailClosed(t *testing.T) {
	s, j, _, _ := owner(t)
	h := admit(t, s, "1")
	ctx, cancel := context.WithCancel(context.Background())
	j.hook = func(port.JournalWrite) { cancel() }
	if _, err := s.Apply(ctx, h, Change{Action: Enqueue}); !errors.Is(err, Cancelled) {
		t.Fatal(err)
	}
	expectUnavailable(t, h)
	s2, j2, _, _ := owner(t)
	h2 := admit(t, s2, "2")
	for _, revision := range []bool{false, true} {
		if revision {
			s2.revision = math.MaxUint64
			s2.fence = 0
		} else {
			s2.revision = 1
			s2.fence = math.MaxUint64
		}
		if _, err := s2.Apply(context.Background(), h2, Change{Action: Enqueue}); !errors.Is(err, Unsettled) || j2.count() != 1 {
			t.Fatal("counter wrapped", err)
		}
	}
}

func TestInvalidClosedChangeCannotTouchJournalOrAnotherRoute(t *testing.T) {
	s, j, _, _ := owner(t)
	h := admit(t, s, "1")
	if _, err := s.Apply(context.Background(), h, Change{Action: "dispatch"}); !errors.Is(err, Invalid) {
		t.Fatal("arbitrary dispatch admitted", err)
	}
	if _, err := s.Apply(context.Background(), h, Change{Action: Enqueue, CallID: "unused"}); !errors.Is(err, Invalid) {
		t.Fatal("irrelevant input accepted", err)
	}
	other := turn.Binding{Reservation: turn.Reservation{Identity: identity(route("other"))}}
	if _, err := s.Apply(context.Background(), h, Change{Action: Accept, Binding: other}); !errors.Is(err, Mismatch) {
		t.Fatal("crossed route", err)
	}
	if j.count() != 1 {
		t.Fatal("invalid change persisted")
	}
}

func TestCancelledAndOversizedInputRefusesBeforeAnyEffect(t *testing.T) {
	s, j, b, r := owner(t)
	h := admit(t, s, "1")
	binding := running(t, s, h)
	writes := j.count()
	if _, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, make([]byte, s.deps.ResultBytesLimit+1)); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if r.calls != 0 || j.count() != writes {
		t.Fatal("unbounded retention input reached effect")
	}
	expectCurrent(t, h, true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Apply(ctx, h, Change{Action: Delta, Binding: binding, Sequence: 2}); !errors.Is(err, Cancelled) {
		t.Fatal(err)
	}
	if _, err := s.Send(context.Background(), h, "prompt", 0, "failure"); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if _, err := s.Send(context.Background(), h, string([]byte{0xff}), 1000, "failure"); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if _, err := s.Send(context.Background(), h, "prompt", 1000, "bad id"); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if _, err := s.PrepareNext(context.Background(), 0); !errors.Is(err, Invalid) {
		t.Fatal(err)
	}
	if j.count() != writes || r.calls != 0 {
		t.Fatal("invalid input performed IO")
	}
	if prepares, sends := b.counts(); prepares != 1 || sends != 1 {
		t.Fatal("invalid input performed browser IO")
	}
}

func TestRevocationWhileRetainingResultRejectsLateRetentionReply(t *testing.T) {
	s, j, _, r := owner(t)
	h := admit(t, s, "1")
	binding := running(t, s, h)
	entered, release := make(chan struct{}), make(chan struct{})
	r.hook = func(port.RetainRequest) { close(entered); <-release }
	writes := j.count()
	done := make(chan error, 1)
	go func() {
		_, err := s.Finish(context.Background(), h, binding, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("answer"))
		done <- err
	}()
	<-entered
	expectUnavailable(t, h)
	if _, err := s.Cancel(context.Background(), h, "cancel"); !errors.Is(err, Unsettled) {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, Unsettled) {
		t.Fatal("late retention reopened route", err)
	}
	expectUnavailable(t, h)
	if j.count() != writes || r.calls != 1 {
		t.Fatal("IO after revoked retention")
	}
}

func TestUnknownSettlementJournalCannotRestorePositiveAfterKnownEffect(t *testing.T) {
	for _, operation := range []string{"prepare", "send", "finish", "cancel"} {
		t.Run(operation, func(t *testing.T) {
			s, j, b, r := owner(t)
			h := admit(t, s, "1")
			var binding turn.Binding
			switch operation {
			case "prepare":
				applyOK(t, s, h, Change{Action: Enqueue})
				b.prepareHook = func(port.PrepareRequest) { j.fault = "error" }
			case "send":
				binding = prepared(t, s, h)
				b.sendHook = func(port.SendRequest) { j.fault = "error" }
			case "finish":
				binding = running(t, s, h)
				r.hook = func(port.RetainRequest) { j.fault = "error" }
			case "cancel":
				j.fault = "error"
			}
			var err error
			switch operation {
			case "prepare":
				_, err = s.PrepareNext(context.Background(), 1000)
			case "send":
				_, err = s.Send(context.Background(), h, "prompt", 1000, "failed")
			case "finish":
				_, err = s.Finish(context.Background(), h, binding, turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, []byte("answer"))
			case "cancel":
				_, err = s.Cancel(context.Background(), h, "cancel")
			}
			if !errors.Is(err, Unsettled) {
				t.Fatal(err)
			}
			expectUnavailable(t, h)
			writes := j.count()
			if _, err := s.Cancel(context.Background(), h, "second-cancel"); !errors.Is(err, Unsettled) || j.count() != writes {
				t.Fatal("unknown settlement retried", err)
			}
		})
	}
}

func TestConstructorAndMissingCapabilitiesFailClosed(t *testing.T) {
	scope := port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}
	j := &journalFixture{}
	for _, deps := range []Dependencies{{}, {Journal: j}, {Gate: gate.New()}, {Gate: gate.New(), Journal: j, Results: &resultFixture{}}, {Gate: gate.New(), Journal: j, Browser: &browserFixture{}}} {
		if s, err := New(context.Background(), scope, deps); s != nil || !errors.Is(err, Invalid) {
			t.Fatal(s, err)
		}
	}
	if j.opened {
		t.Fatal("invalid constructor claimed journal")
	}
	if s, err := New(nil, scope, Dependencies{Gate: gate.New(), Journal: j}); s != nil || !errors.Is(err, Invalid) {
		t.Fatal(s, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if s, err := New(ctx, scope, Dependencies{Gate: gate.New(), Journal: j}); s != nil || !errors.Is(err, Cancelled) || j.opened {
		t.Fatal(s, err)
	}
	s, err := New(context.Background(), scope, Dependencies{Gate: gate.New(), Journal: j})
	if err != nil {
		t.Fatal(err)
	}
	if again, err := New(context.Background(), scope, Dependencies{Gate: gate.New(), Journal: j}); again != nil || !errors.Is(err, Unsettled) {
		t.Fatal("duplicate journal owner", again, err)
	}
	binding := route("1")
	binding.ProfileID, binding.BackendGeneration = scope.ProfileID, scope.BackendGeneration
	h, err := s.Admit(context.Background(), binding, intentDigest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PrepareNext(context.Background(), 1000); !errors.Is(err, Unavailable) {
		t.Fatal(err)
	}
	if _, err := s.Send(context.Background(), h, "prompt", 1000, "failed"); !errors.Is(err, Unavailable) {
		t.Fatal(err)
	}
	if _, err := s.Finish(context.Background(), h, turn.Binding{}, turn.Result{}, nil); !errors.Is(err, Unavailable) {
		t.Fatal(err)
	}
	if j.count() != 1 {
		t.Fatal("missing capability performed IO")
	}
	expectCurrent(t, h, true)
}

func TestFreshJournalClaimCannotBeReplacedByCacheOrUnknownReply(t *testing.T) {
	for _, fault := range []string{"error", "nil", "scope", "revision"} {
		t.Run(fault, func(t *testing.T) {
			j := &journalFixture{openFault: fault}
			s, err := New(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, Dependencies{Gate: gate.New(), Journal: j})
			if s != nil || !errors.Is(err, Unsettled) || !j.opened || j.count() != 0 {
				t.Fatal("unsafe owner from claim", s, err)
			}
		})
	}
}

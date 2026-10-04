package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// CPU-only: real owner, queue, journal sequencing and stream with injected
// browser/storage. Effect counters are simulated; no Computer/native/provider IO.
func relayRunning(t *testing.T) (*Service, *Conversation, *conversationBrowser, *journalFixture, *resultFixture, port.ComputerContext) {
	t.Helper()
	s, b, j, r := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("fixture-user", "fixture-reply", "useful before tool; ")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	correlation, err := c.ComputerContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return s, c, b, j, r, *correlation
}
func relayBegin(t *testing.T, c *Conversation, correlation port.ComputerContext) *ComputerCall {
	t.Helper()
	call, err := c.BeginComputer(context.Background(), correlation, "fixture-call")
	if err != nil {
		t.Fatal(err)
	}
	return call
}
func relayAck(correlation port.ComputerContext) *port.ComputerReturn {
	return &port.ComputerReturn{Context: correlation, CallID: "fixture-call", Returned: true}
}
func relayView(t *testing.T, s *Service, c *Conversation) turn.Snapshot {
	t.Helper()
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	v, err := s.queue.Snapshot(identity(c.handle.fixed))
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestRelayDurableRequestReturnAndContinuedRetainedAnswer(t *testing.T) {
	s, c, b, j, r, correlation := relayRunning(t)
	before := j.count()
	early, err := c.Events(context.Background(), 0)
	if err != nil || len(early) != 4 || !strings.Contains(string(early[3].Data), "useful before tool") {
		t.Fatalf("useful delta missing %v", err)
	}
	call := relayBegin(t, c, correlation)
	if j.count() != before+1 || j.writes[before].Entry.Kind != "request-computer" || relayView(t, s, c).OutstandingCallID != "fixture-call" {
		t.Fatal("request was not durable")
	}
	// This is the selected outer consumer's simulated effect, after known begin
	// and a CURRENT guard from the same admitted owner. It is not a read grant.
	current, err := admissionsvc.New(c.AdmissionOwner())
	if err != nil {
		t.Fatal(err)
	}
	effects := 0
	if err := current.WithCurrent(context.Background(), func(binding *admissionsvc.TaskBinding) error {
		if binding == nil || binding.TurnID != correlation.Binding.TurnID || binding.TaskEpoch != correlation.Binding.TaskEpoch {
			t.Fatal("foreign admission")
		}
		effects++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err != nil {
		t.Fatal(err)
	}
	if j.writes[before+1].Entry.Kind != "resolve-computer" || relayView(t, s, c).OutstandingCallID != "" {
		t.Fatal("exact resolve missing")
	}
	// ACK itself adds no model text or terminal result; next observed text does.
	if _, err := c.Result(context.Background()); err == nil {
		t.Fatal("host return fabricated provider completion")
	}
	b.events = []port.BrowserObservation{
		{Kind: port.Accepted, UserTurnID: "fixture-user"},
		{Kind: port.AnswerDelta, UserTurnID: "fixture-user", ReplyID: "fixture-reply", SegmentID: "segment-fixture-reply", Text: "useful before tool; "},
		{Kind: port.AnswerDelta, UserTurnID: "fixture-user", ReplyID: "fixture-reply", SegmentID: "after-tool", Text: "continued after result"},
		{Kind: port.Completed, UserTurnID: "fixture-user", ReplyID: "fixture-reply"},
		{Kind: port.Quiescent, UserTurnID: "fixture-user", ReplyID: "fixture-reply"},
	}
	observeOK(t, c)
	observeOK(t, c)
	result, err := c.Result(context.Background())
	if err != nil || !result.Complete || result.Text != "useful before tool; continued after result" || r.calls != 1 {
		t.Fatalf("retained=%+v err=%v", result, err)
	}
	if err := c.Acknowledge(context.Background(), result.ResultID); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	if c.handle.releasedRevision == 0 || effects != 1 || len(b.sent) != 1 {
		t.Fatal("not settled exactly once")
	}
	// Request/resolve remain the existing content-free journal kinds.
	bytes, _ := json.Marshal(j.writes)
	for _, private := range []string{"fixture prompt 1", "useful before tool", "continued after result", "fixture private tool arguments", "fixture private result bytes"} {
		if strings.Contains(string(bytes), private) {
			t.Fatal("private body persisted")
		}
	}
	if _, err := c.BeginComputer(context.Background(), correlation, "fixture-call"); err == nil {
		t.Fatal("terminal replay admitted")
	}
}
func TestRelayRejectsChangedMissingAndForeignCorrelationBeforeWrite(t *testing.T) {
	changes := map[string]func(*port.ComputerContext){
		"profile":          func(c *port.ComputerContext) { c.Binding.ProfileID = "other" },
		"backend":          func(c *port.ComputerContext) { c.Binding.BackendGeneration = "other" },
		"owner":            func(c *port.ComputerContext) { c.Binding.OwnerID = "other" },
		"session":          func(c *port.ComputerContext) { c.Binding.SessionID = "other" },
		"task":             func(c *port.ComputerContext) { c.Binding.TaskID = "other" },
		"epoch":            func(c *port.ComputerContext) { c.Binding.TaskEpoch++ },
		"participant":      func(c *port.ComputerContext) { c.Binding.ParticipantID = "other" },
		"turn":             func(c *port.ComputerContext) { c.Binding.TurnID = "other" },
		"operation":        func(c *port.ComputerContext) { c.Binding.OperationID = "other" },
		"turn-generation":  func(c *port.ComputerContext) { c.Binding.TurnGeneration++ },
		"physical-owner":   func(c *port.ComputerContext) { c.Browser.Lease.Identity.OwnerID = "other" },
		"physical-backend": func(c *port.ComputerContext) { c.Browser.Lease.BackendGeneration = "other" },
		"provider-state":   func(c *port.ComputerContext) { c.Browser.ProviderState = port.ProviderHome },
		"slot":             func(c *port.ComputerContext) { c.Browser.Lease.SlotOrdinal++ },
		"slot-generation":  func(c *port.ComputerContext) { c.Browser.Lease.SlotGeneration++ },
		"view":             func(c *port.ComputerContext) { c.Browser.ViewID = "other" },
		"view-generation":  func(c *port.ComputerContext) { c.Browser.ViewGeneration++ },
		"document":         func(c *port.ComputerContext) { c.Browser.DocumentGeneration++ },
		"conversation":     func(c *port.ComputerContext) { c.Browser.ConversationID = "other" },
		"user":             func(c *port.ComputerContext) { c.UserTurnID = "other" },
		"reply":            func(c *port.ComputerContext) { c.ReplyID = "other" },
		"sequence":         func(c *port.ComputerContext) { c.SourceSequence++ },
		"missing":          func(c *port.ComputerContext) { *c = port.ComputerContext{} },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			s, c, b, j, _, correlation := relayRunning(t)
			changed := correlation
			change(&changed)
			before := j.count()
			if call, err := c.BeginComputer(context.Background(), changed, "fixture-call"); err == nil || call != nil {
				t.Fatal("changed begin accepted")
			}
			if j.count() != before || relayView(t, s, c).OutstandingCallID != "" {
				t.Fatal("invalid begin wrote")
			}
			call := relayBegin(t, c, correlation)
			before = j.count()
			ack := relayAck(changed)
			if err := call.AcknowledgeReturn(context.Background(), ack); err == nil {
				t.Fatal("foreign ACK accepted")
			}
			if j.count() != before || relayView(t, s, c).OutstandingCallID != "fixture-call" || len(b.sent) != 1 {
				t.Fatal("foreign ACK changed owner")
			}
		})
	}
	for _, id := range []string{"", "contains space", strings.Repeat("x", 121)} {
		t.Run("bad-call-"+id[:min(len(id), 5)], func(t *testing.T) {
			_, c, _, j, _, correlation := relayRunning(t)
			before := j.count()
			if _, err := c.BeginComputer(context.Background(), correlation, id); err == nil || j.count() != before {
				t.Fatal("invalid call ID accepted")
			}
		})
	}
}
func TestRelayLostReturnAckKeepsLeaseAndCannotReexecuteOrSend(t *testing.T) {
	s, c, b, j, _, correlation := relayRunning(t)
	call := relayBegin(t, c, correlation)
	before := j.count()
	for _, ack := range []*port.ComputerReturn{nil, {Context: correlation, CallID: "fixture-call"}, {Context: correlation, CallID: "other", Returned: true}} {
		if err := call.AcknowledgeReturn(context.Background(), ack); err == nil {
			t.Fatal("missing/changed ACK resolved")
		}
	}
	for _, id := range []string{"fixture-call", "another-call"} {
		if _, err := c.BeginComputer(context.Background(), correlation, id); err == nil {
			t.Fatal("outstanding call reexecuted")
		}
	}
	if err := c.Send(context.Background(), 100); err == nil {
		t.Fatal("resent after lost result ACK")
	}
	v := relayView(t, s, c)
	if j.count() != before || v.OutstandingCallID != "fixture-call" || v.LifecycleSettled || c.handle.releasedRevision != 0 || len(b.sent) != 1 {
		t.Fatal("lost ACK released/resolved/resent")
	}
	// Ordinary status can advance observation while preserving the captured ACK.
	b.events = append(b.events[:2], port.BrowserObservation{Kind: port.Status})
	observeOK(t, c)
	if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err != nil {
		t.Fatal(err)
	}
	before = j.count()
	if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err == nil || j.count() != before {
		t.Fatal("duplicate ACK wrote")
	}
	if _, err := c.BeginComputer(context.Background(), *mustRelayContext(t, c), "fixture-call"); !errors.Is(err, turn.Conflict) {
		t.Fatalf("old call tombstone lost: %v", err)
	}
}
func mustRelayContext(t *testing.T, c *Conversation) *port.ComputerContext {
	t.Helper()
	v, err := c.ComputerContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestRelayRequiresPreparedAcceptedRunningToolsEnabledOwner(t *testing.T) {
	for _, phase := range []string{"pending", "prepared", "submitted", "accepted-no-reply", "missing-epoch", "tools-disabled", "await-owner", "cancelled", "frozen", "unknown"} {
		t.Run(phase, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			i := input("1")
			if phase == "missing-epoch" {
				i.Binding.TaskEpoch = 0
			}
			if phase == "tools-disabled" {
				i.Selection.ToolsEnabled = false
				i.Selection.ConnectorID = ""
				i.Selection.ConnectorGrantID = ""
				i.Required.Connector = false
			}
			c, err := s.CreateConversation(context.Background(), i)
			if err != nil {
				t.Fatal(err)
			}
			if phase != "pending" {
				if _, err := s.PrepareNext(context.Background(), 100); err != nil {
					t.Fatal(err)
				}
			}
			if phase != "pending" && phase != "prepared" {
				b.events = observations("fixture-user", "fixture-reply", "useful")
				if err := c.Send(context.Background(), 100); err != nil {
					t.Fatal(err)
				}
				if phase != "submitted" {
					observeOK(t, c)
					if phase != "accepted-no-reply" {
						observeOK(t, c)
					}
				}
			}
			switch phase {
			case "await-owner":
				v := relayView(t, s, c)
				applyOK(t, s, c.handle, Change{Action: AwaitOwner, Binding: v.Binding})
			case "cancelled":
				if err := c.Cancel(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "frozen":
				if err := s.FreezeAdmissions(context.Background()); err != nil {
					t.Fatal(err)
				}
			case "unknown":
				s.deps.Gate.Lock()
				s.unknown = true
				s.deps.Gate.Unlock()
			}
			before := j.count()
			if _, err := c.ComputerContext(context.Background()); err == nil {
				t.Fatal("ineligible context")
			}
			if _, err := c.BeginComputer(context.Background(), port.ComputerContext{}, "call"); err == nil || j.count() != before {
				t.Fatal("ineligible begin wrote")
			}
		})
	}
}
func TestRelayJournalUncertaintyNeverMintsOrResolvesCall(t *testing.T) {
	for _, action := range []string{"begin", "resolve"} {
		for _, fault := range []string{"error", "nil", "revision", "scope", "entry"} {
			t.Run(action+"-"+fault, func(t *testing.T) {
				s, c, b, j, _, correlation := relayRunning(t)
				var call *ComputerCall
				if action == "resolve" {
					call = relayBegin(t, c, correlation)
				}
				j.fault = fault
				if action == "begin" {
					token, err := c.BeginComputer(context.Background(), correlation, "fixture-call")
					if token != nil || err == nil {
						t.Fatal("unknown request minted effect token")
					}
				} else {
					if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err == nil {
						t.Fatal("unknown resolve published")
					}
				}
				before := j.count()
				if _, err := c.BeginComputer(context.Background(), correlation, "fixture-call"); err == nil {
					t.Fatal("uncertain operation repeated")
				}
				if call != nil {
					if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err == nil {
						t.Fatal("uncertain resolve repeated")
					}
				}
				current, err := admissionsvc.New(c.AdmissionOwner())
				if err != nil {
					t.Fatal(err)
				}
				if err := current.WithCurrent(context.Background(), func(*admissionsvc.TaskBinding) error { t.Fatal("uncertain admission disclosed"); return nil }); err == nil {
					t.Fatal("uncertain current available")
				}
				if !s.unknown || j.count() != before || len(b.sent) != 1 {
					t.Fatal("uncertainty not fenced")
				}
				if action == "resolve" && relayView(t, s, c).OutstandingCallID != "fixture-call" {
					t.Fatal("unknown ACK cleared outstanding call")
				}
			})
		}
	}
}
func TestRelayCancellationFencesPendingBeginAndReturn(t *testing.T) {
	for _, action := range []string{"begin", "resolve"} {
		t.Run(action, func(t *testing.T) {
			s, c, b, j, _, correlation := relayRunning(t)
			var call *ComputerCall
			if action == "resolve" {
				call = relayBegin(t, c, correlation)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			j.hook = func(w port.JournalWrite) {
				if w.Entry.Kind == "request-computer" || w.Entry.Kind == "resolve-computer" {
					close(entered)
					<-release
				}
			}
			done := make(chan error, 1)
			go func() {
				if action == "begin" {
					token, err := c.BeginComputer(context.Background(), correlation, "fixture-call")
					if token != nil {
						done <- errors.New("late token")
						return
					}
					done <- err
				} else {
					done <- call.AcknowledgeReturn(context.Background(), relayAck(correlation))
				}
			}()
			<-entered
			admission, err := admissionsvc.New(c.AdmissionOwner())
			if err != nil {
				t.Fatal(err)
			}
			if err := admission.WithCurrent(context.Background(), func(*admissionsvc.TaskBinding) error { t.Error("pending admission positive"); return nil }); err == nil {
				t.Error("pending guard did not reject")
			}
			if err := c.Cancel(context.Background()); err == nil {
				t.Error("pending cancel falsely settled")
			}
			close(release)
			if err := <-done; err == nil {
				t.Fatal("late journal reply accepted")
			}
			before := j.count()
			if _, err := c.BeginComputer(context.Background(), correlation, "another-call"); err == nil || j.count() != before || len(b.sent) != 1 || !s.unknown || !c.handle.closed {
				t.Fatal("cancel did not fence")
			}
		})
	}
}
func TestRelayConcurrentBeginAndDuplicateReturnSerialize(t *testing.T) {
	s, c, b, j, _, correlation := relayRunning(t)
	var group sync.WaitGroup
	tokens := make(chan *ComputerCall, 16)
	for n := 0; n < 16; n++ {
		group.Add(1)
		go func() {
			defer group.Done()
			call, err := c.BeginComputer(context.Background(), correlation, "fixture-call")
			if err == nil {
				tokens <- call
			}
		}()
	}
	group.Wait()
	close(tokens)
	var token *ComputerCall
	count := 0
	for call := range tokens {
		token = call
		count++
	}
	if count != 1 {
		t.Fatalf("effect tokens=%d", count)
	}
	before := j.count()
	successes := make(chan bool, 16)
	for n := 0; n < 16; n++ {
		group.Add(1)
		go func() {
			defer group.Done()
			successes <- token.AcknowledgeReturn(context.Background(), relayAck(correlation)) == nil
		}()
	}
	group.Wait()
	close(successes)
	count = 0
	for ok := range successes {
		if ok {
			count++
		}
	}
	if count != 1 || j.count() != before+1 || relayView(t, s, c).OutstandingCallID != "" || len(b.sent) != 1 {
		t.Fatal("concurrent ACK duplicated")
	}
}
func TestRelayCancelledContextClosedOwnerAndRetirementRefuse(t *testing.T) {
	t.Run("cancelled-context", func(t *testing.T) {
		_, c, _, j, _, correlation := relayRunning(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		before := j.count()
		if _, err := c.BeginComputer(ctx, correlation, "call"); err == nil || j.count() != before {
			t.Fatal("cancelled context wrote")
		}
	})
	t.Run("closed-owner", func(t *testing.T) {
		_, c, _, j, _, correlation := relayRunning(t)
		call := relayBegin(t, c, correlation)
		if err := c.Cancel(context.Background()); err != nil {
			t.Fatal(err)
		}
		before := j.count()
		if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err == nil || j.count() != before {
			t.Fatal("closed owner resolved")
		}
	})
	t.Run("retirement", func(t *testing.T) {
		s, c, _, _, _, correlation := relayRunning(t)
		call := relayBegin(t, c, correlation)
		if err := s.FreezeAdmissions(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := s.retirementTurns(); err == nil {
			t.Fatal("outstanding call allowed retirement")
		}
		if _, err := c.BeginComputer(context.Background(), correlation, "another"); err == nil {
			t.Fatal("frozen begin")
		}
		// Existing known return can settle under freeze; it cannot admit new work.
		if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("zero-handles", func(t *testing.T) {
		if (&Conversation{}).AdmissionOwner() != nil {
			t.Fatal("forged owner")
		}
		if _, err := (&Conversation{}).ComputerContext(context.Background()); err == nil {
			t.Fatal("forged context")
		}
		if _, err := (&Conversation{}).BeginComputer(context.Background(), port.ComputerContext{}, "call"); err == nil {
			t.Fatal("forged begin")
		}
		if err := (&ComputerCall{}).AcknowledgeReturn(context.Background(), nil); err == nil {
			t.Fatal("forged ACK")
		}
	})
}

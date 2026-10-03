package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// CPU fixtures around the real lifecycle service. No browser, filesystem journal,
// provider account, connector, host operation or client compatibility is claimed.
type conversationBrowser struct {
	verifyHook func(*port.SendVerification)
	browserFixture
	prepares                    []port.PrepareRequest
	verifies                    []port.VerifySendRequest
	sent                        []port.SendRequest
	events                      []port.BrowserObservation
	verifyFault, sendReplyFault string
	observeFault                string
	prepareOther                bool
	observeHook                 func(port.ObserveRequest)
}

func (b *conversationBrowser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	b.prepares = append(b.prepares, r)
	cid := "fixture-conversation"
	if r.Lease.Identity.TaskID != "task-1" {
		cid += "-" + r.Lease.Identity.TaskID
	}
	if r.Target.Mode == port.OwnedSaved {
		cid = r.Target.ConversationID
	}
	if b.prepareOther {
		cid = "other-conversation"
	}
	state, saved := port.ProviderHome, false
	if r.Target.Mode == port.NewSaved {
		cid = ""
	} else {
		state, saved = port.ProviderBound, true
	}
	return &port.PrepareResponse{Saved: saved, Readiness: port.Ready, Binding: port.BrowserBinding{ProviderState: state, Lease: r.Lease, ViewID: fmt.Sprintf("view-%d", r.Lease.SlotOrdinal), ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationID: cid}}, nil
}
func (b *conversationBrowser) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	b.verifies = append(b.verifies, r)
	v := &port.SendVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: fixtureFacts(r.Requested), PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: r.IntentDigest, EvidenceID: fmt.Sprintf("verify-%d", len(b.verifies))}
	switch b.verifyFault {
	case "account":
		v.Pinned.AccountID = "other"
	case "model":
		v.Observed.Model.Value = "other"
	case "effort":
		v.Observed.Effort.Value = "high"
	case "connector":
		v.Observed.Connector.Value = "other"
	case "mode":
		v.Observed.Mode.Value = "pro"
	case "grant":
		v.Pinned.ConnectorGrantID = "other"
	case "digest":
		v.IntentDigest = strings.Repeat("f", 64)
	case "view":
		v.Binding.ViewGeneration++
	case "document":
		v.Binding.DocumentGeneration++
	case "lease":
		v.Binding.Lease.SlotGeneration++
	case "user":
		v.PreviousUserTurnID = "other"
	case "reply":
		v.PreviousReplyID = "other"
	case "reuse":
		v.EvidenceID = "verify-1"
	case "nil":
		return nil, nil
	case "error":
		return nil, errors.New("private verification diagnostic")
	}
	if b.verifyHook != nil {
		b.verifyHook(v)
	}
	return v, nil
}
func (b *conversationBrowser) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.sent = append(b.sent, r)
	reply := &port.SendResponse{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: port.Submitted}
	switch b.sendReplyFault {
	case "nil":
		return nil, nil
	case "error":
		return nil, errors.New("private send diagnostic")
	case "witness":
		reply.VerificationID = "other"
	case "not-sent":
		reply.Status = port.NotSent
	}
	return reply, nil
}
func (b *conversationBrowser) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	if b.observeHook != nil {
		b.observeHook(r)
	}
	if r.AfterSequence >= uint64(len(b.events)) {
		return &port.ObserveResponse{}, nil
	}
	event := b.events[r.AfterSequence]
	event.Binding = r.Binding
	if event.Kind == port.Accepted && r.Binding.ProviderState == port.ProviderHome {
		event.ProviderConversationID = "fixture-conversation"
		if r.Binding.Lease.Identity.TaskID != "task-1" {
			event.ProviderConversationID += "-" + r.Binding.Lease.Identity.TaskID
		}
	}
	event.Sequence = r.AfterSequence + 1
	switch b.observeFault {
	case "binding":
		event.Binding.DocumentGeneration++
	case "sequence":
		event.Sequence++
	case "user":
		event.UserTurnID = "other"
	case "size":
		event.ReplyID = strings.Repeat("x", 121)
	case "error":
		return nil, errors.New("private observe diagnostic")
	case "gap":
		return &port.ObserveResponse{Gap: true}, nil
	}
	return &port.ObserveResponse{Events: []port.BrowserObservation{event}}, nil
}
func selected() port.Selection {
	return port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "fixture-account", ModelID: "fixture-cheap", Effort: "low", ToolsEnabled: true, ConnectorID: "fixture-connector", ConnectorGrantID: "fixture-grant"}
}
func conversationOwner(t *testing.T) (*Service, *conversationBrowser, *journalFixture, *resultFixture) {
	t.Helper()
	b, j, r := &conversationBrowser{}, &journalFixture{}, &resultFixture{}
	s, err := New(context.Background(), port.JournalScope{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend"}, Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: r, ResultBytesLimit: OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	return s, b, j, r
}
func input(n string) port.ConversationInput {
	return port.ConversationInput{Required: port.RequiredControls{Model: true, Effort: true, Connector: true}, Binding: route(n), Selection: selected(), Prompt: "fixture prompt " + n}
}
func createPrepared(t *testing.T, s *Service) (*Conversation, *port.BrowserBinding) {
	t.Helper()
	c, err := s.CreateConversation(context.Background(), input("1"))
	if err != nil {
		t.Fatal(err)
	}
	binding, err := s.PrepareNext(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	return c, binding
}
func observations(user, reply, text string) []port.BrowserObservation {
	return []port.BrowserObservation{{Kind: port.Accepted, UserTurnID: user}, {Kind: port.AnswerDelta, UserTurnID: user, ReplyID: reply, SegmentID: "segment-" + reply, Text: text}, {Kind: port.Completed, UserTurnID: user, ReplyID: reply}, {Kind: port.Quiescent, UserTurnID: user, ReplyID: reply}}
}
func observeOK(t *testing.T, c *Conversation) {
	t.Helper()
	if err := c.Observe(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
}
func followInput() port.ConversationInput {
	i := input("1")
	i.Binding.TurnID = "turn-2"
	i.Binding.OperationID = "operation-2"
	i.Binding.TurnGeneration++
	i.Prompt = "Return the fixture nonce."
	return i
}
func completedFirst(t *testing.T, s *Service, b *conversationBrowser) (*Conversation, port.ConversationInput) {
	t.Helper()
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "pear")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	r, err := c.Result(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Acknowledge(context.Background(), r.ResultID); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	return c, followInput()
}
func TestConversationCanonicalFollowupAndIncrementalResult(t *testing.T) {
	bytes, err := os.ReadFile("../../../contracts/conversation/testdata/followup.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Selection    port.Selection `json:"selection"`
		Conversation string         `json:"provider_conversation"`
		Turns        []struct {
			Operation, Turn, Prompt string
			User                    string `json:"user_turn"`
			Reply                   string
			Segments                []struct{ ID, Text string }
		}
	}
	if err := json.Unmarshal(bytes, &vector); err != nil {
		t.Fatal(err)
	}
	s, b, j, retained := conversationOwner(t)
	ctx := context.Background()
	first := input("1")
	first.Selection = vector.Selection
	first.Prompt = vector.Turns[0].Prompt
	c, err := s.CreateConversation(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	binding, err := s.PrepareNext(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	b.events = observations(vector.Turns[0].User, vector.Turns[0].Reply, vector.Turns[0].Segments[0].Text)
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	if _, err := c.Result(ctx); err != Unsettled {
		t.Fatalf("early result=%v", err)
	}
	early, err := c.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(early) != 4 || !strings.Contains(string(early[3].Data), "response.output_text.delta") || strings.Contains(string(early[3].Data), "response.completed") {
		t.Fatalf("incremental frames=%+v", early)
	}
	if _, err := s.FollowConversation(ctx, c, followInput()); err != Unsettled {
		t.Fatalf("unsettled follow=%v", err)
	}
	observeOK(t, c)
	result, err := c.Result(ctx)
	if err != nil || !result.Complete || result.Text != "pear" || result.Acknowledged || result.Observed != fixtureFacts(vector.Selection).Projection() {
		t.Fatalf("result=%+v %v", result, err)
	}
	for n := 0; n < 2; n++ {
		if _, err := c.Result(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Events(ctx, 0); err != nil {
			t.Fatal(err)
		}
	}
	replay, err := s.CreateConversation(ctx, first)
	if err != nil || replay != c {
		t.Fatalf("replay=%p %v", replay, err)
	}
	if len(b.sent) != 1 {
		t.Fatal("reads redispatched")
	}
	if _, err := s.FollowConversation(ctx, c, followInput()); err != Unsettled {
		t.Fatal("result read released slot")
	}
	if err := c.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FollowConversation(ctx, c, followInput()); err != Unsettled {
		t.Fatal("ACK without quiescence released")
	}
	observeOK(t, c)
	second := followInput()
	second.Prompt = vector.Turns[1].Prompt
	next, err := s.FollowConversation(ctx, c, second)
	if err != nil {
		t.Fatal(err)
	}
	nextBinding, err := s.PrepareNext(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if nextBinding.ConversationID != vector.Conversation || binding.ConversationID != "" || binding.ProviderState != port.ProviderHome || nextBinding.ProviderState != port.ProviderBound || nextBinding.Lease.SlotOrdinal != binding.Lease.SlotOrdinal || nextBinding.Lease.SlotGeneration != binding.Lease.SlotGeneration+1 {
		t.Fatalf("follow binding=%+v", nextBinding)
	}
	b.events = observations(vector.Turns[1].User, vector.Turns[1].Reply, vector.Turns[1].Segments[0].Text)
	if err := next.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, next)
	observeOK(t, next)
	observeOK(t, next)
	nextResult, err := next.Result(ctx)
	if err != nil || !nextResult.Complete || nextResult.Text != "pear" {
		t.Fatalf("next=%+v %v", nextResult, err)
	}
	if len(b.sent) != 2 || len(b.verifies) != 2 || b.sent[0].Verification.EvidenceID == b.sent[1].Verification.EvidenceID || b.verifies[1].PreviousUserTurnID != vector.Turns[0].User || b.verifies[1].PreviousReplyID != vector.Turns[0].Reply || b.verifies[1].Binding != *nextBinding {
		t.Fatal("fresh exact followup verification missing")
	}
	encoded, _ := json.Marshal(j.writes)
	if strings.Contains(string(encoded), "pear") || strings.Contains(string(encoded), "fixture prompt") {
		t.Fatal("journal disclosed private content")
	}
	if retained.calls != 2 || string(retained.payload) != "pear" {
		t.Fatal("actual known retention missing")
	}
}
func TestVerificationMismatchNeverCallsSend(t *testing.T) {
	for _, fault := range []string{"account", "model", "effort", "connector", "mode", "grant", "digest", "view", "document", "lease", "user", "reply", "nil", "error"} {
		t.Run(fault, func(t *testing.T) {
			s, b, _, _ := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.verifyFault = fault
			if err := c.Send(context.Background(), 100); err != Unsettled {
				t.Fatalf("send=%v", err)
			}
			if len(b.sent) != 0 || len(b.verifies) != 1 {
				t.Fatal("verification failure sent")
			}
			if err := c.Send(context.Background(), 100); err != Unsettled {
				t.Fatal("unknown verification retried")
			}
			if len(b.verifies) != 1 || len(b.sent) != 0 {
				t.Fatal("retried effect")
			}
		})
	}
}
func TestLostSendReplyIsStickyAndNeverResends(t *testing.T) {
	for _, fault := range []string{"nil", "error", "witness", "not-sent"} {
		t.Run(fault, func(t *testing.T) {
			s, b, _, r := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.sendReplyFault = fault
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			result, err := c.Result(context.Background())
			if err != nil || result.Complete {
				t.Fatalf("result=%+v %v", result, err)
			}
			if fault == "not-sent" {
				if result.Outcome != string(turn.Failed) || r.calls != 1 {
					t.Fatal("known failure not retained")
				}
			} else if result.Outcome != string(turn.UnknownOutcome) {
				t.Fatal("lost reply became known")
			}
			if err := c.Send(context.Background(), 100); err == nil {
				t.Fatal("second Send accepted")
			}
			frames, err := c.Events(context.Background(), 0)
			if err != nil || len(frames) != 1 || !strings.Contains(string(frames[0].Data), "response.failed") {
				t.Fatalf("terminal=%+v %v", frames, err)
			}
			if len(b.sent) != 1 || len(b.verifies) != 1 {
				t.Fatal("lost reply resent")
			}
		})
	}
}
func TestFollowBindingChangesRefuseBeforeSecondSend(t *testing.T) {
	for _, fault := range []string{"conversation", "reuse", "model", "user"} {
		t.Run(fault, func(t *testing.T) {
			s, b, _, _ := conversationOwner(t)
			c, in := completedFirst(t, s, b)
			next, err := s.FollowConversation(context.Background(), c, in)
			if err != nil {
				t.Fatal(err)
			}
			if fault == "conversation" {
				b.prepareOther = true
			}
			_, err = s.PrepareNext(context.Background(), 100)
			if fault == "conversation" {
				if err != Unsettled {
					t.Fatal("wrong conversation prepared")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			b.verifyFault = fault
			if err := next.Send(context.Background(), 100); err != Unsettled {
				t.Fatal("invalid follow witness accepted")
			}
			if len(b.sent) != 1 {
				t.Fatal("follow failure sent")
			}
		})
	}
}
func TestSemanticRedrawEqualBlocksAndChangedCommittedBlock(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "same")
	first := b.events[1]
	other := first
	other.SegmentID = "second"
	changed := first
	changed.Text = "changed"
	b.events = []port.BrowserObservation{b.events[0], first, first, other, changed}
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	frames, err := c.Events(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	deltas := 0
	for _, frame := range frames {
		if strings.Contains(string(frame.Data), "response.output_text.delta") {
			deltas++
		}
	}
	if deltas != 2 || c.handle.output.Text() != "samesame" {
		t.Fatal("text identity dedup lost repeated paragraph")
	}
	if err := c.Observe(context.Background(), 100); err != Unsettled {
		t.Fatal("mutated committed output published")
	}
	if len(b.sent) != 1 {
		t.Fatal("mutation resent")
	}
}
func TestLateObservationCancellationCannotPublish(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "pear")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	b.observeHook = func(port.ObserveRequest) {
		if err := c.Cancel(context.Background()); err != Unsettled {
			t.Fatalf("cancel=%v", err)
		}
	}
	if err := c.Observe(context.Background(), 100); err != Unsettled {
		t.Fatal("late observation published")
	}
	if c.handle.output.Accepted || c.handle.frames.Snapshot().LastSequence != 0 || len(b.sent) != 1 {
		t.Fatal("late observation reopened")
	}
}
func TestFrameACKDoesNotAcknowledgeResultAndReplayIsExact(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "pear")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	frames, err := c.Events(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range frames {
		if _, err := c.AcknowledgeFrame(context.Background(), f.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	result, err := c.Result(context.Background())
	if err != nil || result.Acknowledged {
		t.Fatal("frame ACK released business delivery")
	}
	replay, err := c.Events(context.Background(), 3)
	if err != nil || len(replay) != len(frames)-3 || string(replay[0].Data) != string(frames[3].Data) {
		t.Fatal("reconnect order changed")
	}
	if _, err := s.FollowConversation(context.Background(), c, followInput()); err != Unsettled {
		t.Fatal("socket delivery released")
	}
}

func TestConversationSixthWaitsWithoutCreatingSixthView(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	ctx := context.Background()
	var first *Conversation
	for n := 1; n <= 6; n++ {
		c, err := s.CreateConversation(ctx, input(fmt.Sprint(n)))
		if err != nil {
			t.Fatal(err)
		}
		if n == 1 {
			first = c
		}
	}
	for n := 1; n <= 5; n++ {
		binding, err := s.PrepareNext(ctx, 100)
		if err != nil || binding.Lease.SlotOrdinal != uint8(n) {
			t.Fatalf("slot %d: %+v %v", n, binding, err)
		}
	}
	if _, err := s.PrepareNext(ctx, 100); err != turn.Capacity || len(b.prepares) != 5 {
		t.Fatalf("sixth prepared: %v", err)
	}
	b.events = observations("user-1", "reply-1", "pear")
	if err := first.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, first)
	observeOK(t, first)
	observeOK(t, first)
	observeOK(t, first)
	if _, err := s.PrepareNext(ctx, 100); err != turn.Capacity {
		t.Fatal("quiescence without ACK reused")
	}
	if err := first.Acknowledge(ctx, first.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	binding, err := s.PrepareNext(ctx, 100)
	if err != nil || len(b.prepares) != 6 || binding.Lease.Identity.TaskID != "task-6" || binding.Lease.SlotOrdinal != 1 || binding.Lease.SlotGeneration != 2 {
		t.Fatalf("sixth=%+v %v", binding, err)
	}
}
func TestConversationCannotForkOldSettledTurn(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	first, in := completedFirst(t, s, b)
	if _, err := s.FollowConversation(context.Background(), first, in); err != nil {
		t.Fatal(err)
	}
	fork := in
	fork.Binding.OperationID = "fork-operation"
	fork.Binding.TurnID = "fork-turn"
	fork.Binding.TurnGeneration++
	if _, err := s.FollowConversation(context.Background(), first, fork); err != turn.Conflict {
		t.Fatalf("old turn forked: %v", err)
	}
}
func TestFrozenOwnerCanSettleButRetirementRefusesActiveObservation(t *testing.T) {
	b, j := &conversationBrowser{}, &retirementJournal{}
	s, err := New(context.Background(), port.JournalScope{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend"}, Dependencies{Gate: gate.New(), Journal: j, Browser: b, Results: &resultFixture{}, ResultBytesLimit: OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "pear")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	b.observeHook = func(port.ObserveRequest) {
		if _, err := s.Retire(context.Background()); err != Busy {
			t.Fatalf("retirement during Observe=%v", err)
		}
	}
	observeOK(t, c)
	if _, err := s.Retire(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestObservationMismatchNeverRebindsOrResends(t *testing.T) {
	for _, fault := range []string{"binding", "sequence", "user", "size", "error", "gap"} {
		t.Run(fault, func(t *testing.T) {
			s, b, _, _ := conversationOwner(t)
			c, _ := createPrepared(t, s)
			b.events = observations("user-1", "reply-1", "pear")
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			observeOK(t, c)
			b.observeFault = fault
			if err := c.Observe(context.Background(), 100); err != Unsettled {
				t.Fatalf("Observe=%v", err)
			}
			if c.handle.output.Text() != "" || len(b.sent) != 1 {
				t.Fatal("mismatched observation published or resent")
			}
		})
	}
}
func TestBackpressureIsBoundedAndFrameACKAllowsContiguousReconnect(t *testing.T) {
	for _, ack := range []bool{false, true} {
		t.Run(fmt.Sprint(ack), func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			c, _ := createPrepared(t, s)
			c.handle.frames, _ = stream.New(streamScope(c.handle.fixed), stream.Limits{Frames: 4, FrameBytes: 1024, Bytes: 4096})
			block := port.BrowserObservation{Kind: port.AnswerDelta, UserTurnID: "user-1", ReplyID: "reply-1", SegmentID: "block", Text: "one"}
			second := block
			second.SegmentID = "second"
			second.Text = "two"
			b.events = []port.BrowserObservation{{Kind: port.Accepted, UserTurnID: "user-1"}, block, second}
			if err := c.Send(context.Background(), 100); err != nil {
				t.Fatal(err)
			}
			observeOK(t, c)
			observeOK(t, c)
			if ack {
				frames, err := c.Events(context.Background(), 0)
				if err != nil {
					t.Fatal(err)
				}
				for _, frame := range frames {
					if _, err := c.AcknowledgeFrame(context.Background(), frame.Sequence); err != nil {
						t.Fatal(err)
					}
				}
			}
			writes := j.count()
			err := c.Observe(context.Background(), 100)
			if !ack {
				if err != Unsettled || j.count() != writes || c.handle.output.Text() != "one" {
					t.Fatal("overflow published partial state")
				}
				return
			}
			if err != nil || c.handle.output.Text() != "onetwo" {
				t.Fatalf("drained result=%v", err)
			}
			if _, err := c.Events(context.Background(), 0); err != stream.Gap {
				t.Fatal("eviction hid reconnect gap")
			}
			frames, err := c.Events(context.Background(), 4)
			if err != nil || len(frames) != 1 || frames[0].Sequence != 5 {
				t.Fatal("contiguous reconnect changed")
			}
			if len(b.sent) != 1 {
				t.Fatal("backpressure resent")
			}
		})
	}
}
func TestPrivateBytesAndSelectionConflictBeforeEffects(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	ctx := context.Background()
	i := input("1")
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	for _, changed := range []port.ConversationInput{
		{Required: i.Required, Binding: i.Binding, Selection: i.Selection, Prompt: "different"},
		{Required: port.RequiredControls{Model: true, Effort: true}, Binding: i.Binding, Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "other", ModelID: "fixture-cheap", Effort: "low"}, Prompt: i.Prompt},
	} {
		if _, err := s.CreateConversation(ctx, changed); err != turn.Conflict {
			t.Fatalf("conflict=%v", err)
		}
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Send(ctx, c.handle, "changed prompt", 100, i.Binding.OperationID); err != Mismatch {
		t.Fatalf("changed Send=%v", err)
	}
	if len(b.sent) != 0 || len(b.verifies) != 0 {
		t.Fatal("intent conflict made effects")
	}
}

func TestInvocationSelectionEvidenceRemainsImmutableWhileQueued(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	ctx := context.Background()
	i := input("1")
	original := i.Selection
	i.Resolution = port.ModelResolution{RequestedAlias: "configured-cheap", RequestedExecutor: "farol", RequestedEffort: "", Resolved: original, ConfigSHA256: strings.Repeat("a", 64), TranslationID: "fixture-default-to-low"}
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	check := func(e port.SelectionEvidence) {
		if e.Requested != original || e.Resolution.Resolved != original || e.Resolution.RequestedEffort != "" || e.ResolutionSource != "configured" {
			t.Fatalf("immutable evidence=%+v", e)
		}
	}
	if err := c.WithConversation(ctx, func(state port.ConversationState) error {
		check(state.Evidence)
		if state.Evidence.AdmissionSource != "unknown" || state.Evidence.ObservationSource != "unknown" || state.Evidence.Observed != (port.SelectionFacts{}).Projection() {
			t.Fatal("ready echoed input as admission/observation")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	i.Selection.ModelID = "edited-model"
	i.Resolution.Resolved = i.Selection
	i.Resolution.ConfigSHA256 = strings.Repeat("b", 64)
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if b.verifies[0].Requested != original {
		t.Fatal("queued selection silently re-resolved")
	}
	if err := c.WithConversation(ctx, func(state port.ConversationState) error {
		check(state.Evidence)
		if state.Evidence.AdmissionSource != "chat-policy" || state.Evidence.ObservationSource != "field-facts" || state.Evidence.Observed != fixtureFacts(original).Projection() {
			t.Fatal("selection proof strength missing")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateConversation(ctx, i); err != turn.Conflict {
		t.Fatal("historical selection rewritten")
	}
}
func TestMissingResolutionProofAndInvalidTranslationAreExplicit(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	i := input("1")
	ctx := context.Background()
	wrong := i
	wrong.Resolution = port.ModelResolution{RequestedAlias: "alias", RequestedExecutor: "farol", Resolved: i.Selection, ConfigSHA256: strings.Repeat("a", 64), TranslationID: "fixture"}
	wrong.Resolution.Resolved.ModelID = "different"
	if _, err := s.CreateConversation(ctx, wrong); err != Invalid {
		t.Fatalf("crossed resolution=%v", err)
	}
	if len(b.prepares) != 0 || len(b.sent) != 0 {
		t.Fatal("invalid resolution made effects")
	}
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WithConversation(ctx, func(state port.ConversationState) error {
		if state.Evidence.ResolutionSource != "unknown" || state.Evidence.Resolution != (port.ModelResolution{}) {
			t.Fatal("missing proof invented")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestRefusalAfterDeltaRetainsIncompleteMessage(t *testing.T) {
	s, b, _, retained := conversationOwner(t)
	c, _ := createPrepared(t, s)
	ctx := context.Background()
	events := observations("user-1", "reply-1", "partial")
	events[2].Kind = port.Refused
	b.events = events
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	result, err := c.Result(ctx)
	if err != nil || result.Complete || result.Outcome != string(turn.Refused) || result.Text != "partial" || string(retained.payload) != "partial" {
		t.Fatalf("partial=%+v %v", result, err)
	}
	frames, err := c.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	var event struct {
		Type     string `json:"type"`
		Response struct {
			Status string `json:"status"`
			Output []struct {
				Status string `json:"status"`
			} `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(frames[len(frames)-1].Data, &event) != nil || event.Type != "response.failed" || event.Response.Status != "failed" || len(event.Response.Output) != 1 || event.Response.Output[0].Status != "incomplete" {
		t.Fatalf("failure event=%+v", event)
	}
	if len(b.sent) != 1 {
		t.Fatal("refusal resent")
	}
}

func fixtureFacts(s port.Selection) port.SelectionFacts {
	known := func(v string) port.ControlFact {
		if v == "" {
			return port.ControlFact{}
		}
		return port.ControlFact{Value: v, Literal: "visible-" + v, Source: port.FactPublicControl}
	}
	return port.SelectionFacts{Model: known(s.ModelID), Effort: known(s.Effort), Mode: known(s.Mode), Connector: known(s.ConnectorID), ObservedAtMillis: 9}
}

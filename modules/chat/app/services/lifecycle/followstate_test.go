package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// These CPU fixtures use the real owner/gate/queue and existing injected doubles.
// They do not prove native, filesystem, browser, provider or package behavior.
func assertFollowState(t *testing.T, c *Conversation, want [5]bool) port.ConversationState {
	t.Helper()
	b := c.owner.deps.Browser.(*conversationBrowser)
	j := c.owner.deps.Journal.(*journalFixture)
	r := c.owner.deps.Results.(*resultFixture)
	before := ownerReadProbe(t, c)
	writes, prepares, verifies, sends, retains := j.count(), len(b.prepares), len(b.verifies), len(b.sent), r.calls
	var state port.ConversationState
	if err := c.WithConversation(context.Background(), func(s port.ConversationState) error {
		state = s
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got := [5]bool{state.HasResult, state.DeliveryAcknowledged, state.LifecycleSettled, state.Released, state.FollowReady}
	if got != want || state.Binding != c.handle.fixed || state.Requested != c.handle.target.Selection {
		t.Fatalf("state=%+v flags=%v want=%v", state, got, want)
	}
	assertOwnerReadUnchanged(t, c, before)
	if j.count() != writes || len(b.prepares) != prepares || len(b.verifies) != verifies || len(b.sent) != sends || r.calls != retains {
		t.Fatal("state read invoked an effect port")
	}
	return state
}

func followCompleted(t *testing.T) (*Service, *Conversation, *conversationBrowser, *journalFixture, *resultFixture) {
	t.Helper()
	s, b, j, r := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "pear")
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 3; n++ {
		observeOK(t, c)
	}
	return s, c, b, j, r
}

func TestFollowStateRequiresAcknowledgementSettlementAndCommittedRelease(t *testing.T) {
	for _, ackFirst := range []bool{true, false} {
		name := "settlement-first"
		if ackFirst {
			name = "ack-first"
		}
		t.Run(name, func(t *testing.T) {
			s, c, _, j, retained := followCompleted(t)
			ctx := context.Background()
			result, err := c.Result(ctx)
			if err != nil || !result.Complete || result.Text != "pear" {
				t.Fatal("actual completed result missing", result, err)
			}
			assertFollowState(t, c, [5]bool{true, false, false, false, false})
			view := relayView(t, s, c)
			ack := Change{Action: Acknowledge, ResultID: result.ResultID}
			settle := Change{Action: Settle, Quiescence: turn.QuiescenceEvidence{Binding: view.Binding, ResultID: result.ResultID, Sequence: view.LastSequence + 1, Confirmed: true}}
			first, second := ack, settle
			want := [5]bool{true, true, false, false, false}
			if !ackFirst {
				first, second = settle, ack
				want = [5]bool{true, false, true, false, false}
			}
			if _, err := s.Apply(ctx, c.handle, first); err != nil {
				t.Fatal(err)
			}
			assertFollowState(t, c, want)
			if _, err := s.FollowConversation(ctx, c, followInput()); err != Unsettled {
				t.Fatal("one prerequisite permitted Follow", err)
			}
			if _, err := s.Apply(ctx, c.handle, second); err != nil {
				t.Fatal(err)
			}
			// Apply commits each owning transition separately, so both witnesses
			// can be observed before the original release is committed.
			assertFollowState(t, c, [5]bool{true, true, true, false, false})
			if _, err := s.FollowConversation(ctx, c, followInput()); err != Unsettled {
				t.Fatal("unreleased turn permitted Follow", err)
			}
			before, err := c.Result(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Apply(ctx, c.handle, Change{Action: Release, Reservation: view.Reservation}); err != nil {
				t.Fatal(err)
			}
			state := assertFollowState(t, c, [5]bool{true, true, true, true, true})
			if state.Prepared || j.writes[len(j.writes)-1].Entry.Kind != "release" || c.handle.releasedRevision != j.writes[len(j.writes)-1].Revision {
				t.Fatal("release was inferred from retained queue binding")
			}
			after, err := c.Result(ctx)
			if err != nil || *after != *before || retained.calls != 1 || string(retained.payload) != "pear" {
				t.Fatal("projection changed retained result", after, err)
			}
		})
	}
}

func TestFollowStateRunningReadsAreObservationOnly(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	ctx := context.Background()
	c, err := s.CreateConversation(ctx, input("1"))
	if err != nil {
		t.Fatal(err)
	}
	state := assertFollowState(t, c, [5]bool{})
	if state.Prepared {
		t.Fatal("queued turn advertised preparation")
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if !assertFollowState(t, c, [5]bool{}).Prepared {
		t.Fatal("existing prepared state lost")
	}
	b.events = observations("user-1", "reply-1", "pear")
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal("observation changed explicit Send behavior", err)
	}
	assertFollowState(t, c, [5]bool{})
	observeOK(t, c)
	assertFollowState(t, c, [5]bool{})
	observeOK(t, c)
	assertFollowState(t, c, [5]bool{})
	observeOK(t, c)
	assertFollowState(t, c, [5]bool{true, false, false, false, false})
	if len(b.sent) != 1 {
		t.Fatal("state reads sent again")
	}
}

func TestFollowStateAutomaticReleaseInBothOrders(t *testing.T) {
	for _, ackFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "ack-first", false: "settlement-first"}[ackFirst], func(t *testing.T) {
			_, c, _, _, _ := followCompleted(t)
			ack := func() {
				if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != nil {
					t.Fatal(err)
				}
			}
			if ackFirst {
				ack()
				assertFollowState(t, c, [5]bool{true, true, false, false, false})
				observeOK(t, c)
			} else {
				observeOK(t, c)
				assertFollowState(t, c, [5]bool{true, false, true, false, false})
				ack()
			}
			assertFollowState(t, c, [5]bool{true, true, true, true, true})
		})
	}
}

func TestFollowStateOldHandleRetainsResultAndExactSuccessorReplay(t *testing.T) {
	s, b, j, _ := conversationOwner(t)
	ctx := context.Background()
	first, in := completedFirst(t, s, b)
	assertFollowState(t, first, [5]bool{true, true, true, true, true})
	released := first.handle.releasedRevision
	before, err := first.Result(ctx)
	if err != nil {
		t.Fatal(err)
	}
	next, err := s.FollowConversation(ctx, first, in)
	if err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, first, [5]bool{true, true, true, true, false})
	assertFollowState(t, next, [5]bool{})
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	b.events = observations("user-2", "reply-2", "next answer")
	if err := next.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 4; n++ {
		observeOK(t, next)
	}
	if err := next.Acknowledge(ctx, in.Binding.OperationID); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, next, [5]bool{true, true, true, true, true})
	thirdInput := in
	thirdInput.Binding.OperationID, thirdInput.Binding.TurnID = "operation-3", "turn-3"
	thirdInput.Binding.TurnGeneration++
	if _, err := s.FollowConversation(ctx, next, thirdInput); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, next, [5]bool{true, true, true, true, false})
	assertFollowState(t, first, [5]bool{true, true, true, true, false})
	writes, sends := j.count(), len(b.sent)
	replay, err := s.FollowConversation(ctx, first, in)
	if err != nil || replay != next {
		t.Fatal("exact known successor replay changed", replay, err)
	}
	changed := in
	changed.Prompt += " changed"
	if _, err := s.FollowConversation(ctx, first, changed); err != turn.Conflict {
		t.Fatal("changed intent replay accepted", err)
	}
	if _, err := s.FollowConversation(ctx, first, thirdInput); err != turn.Conflict {
		t.Fatal("old handle permitted a fork", err)
	}
	after, err := first.Result(ctx)
	if err != nil || *after != *before || first.handle.releasedRevision != released || j.count() != writes || len(b.sent) != sends {
		t.Fatal("old handle observation/replay changed result or released again", after, err)
	}
}

func TestFollowStateUnknownReleaseIsUnavailable(t *testing.T) {
	for _, fault := range []string{"nil", "error", "revision"} {
		t.Run(fault, func(t *testing.T) {
			_, c, b, j, _ := followCompleted(t)
			observeOK(t, c)
			assertFollowState(t, c, [5]bool{true, false, true, false, false})
			j.hook = func(w port.JournalWrite) {
				if w.Entry.Kind == "release" {
					called := false
					if err := c.WithConversation(context.Background(), func(port.ConversationState) error { called = true; return nil }); err != Busy || called {
						t.Fatal("pending release published state", err)
					}
					j.fault = fault
				}
			}
			if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != Unsettled {
				t.Fatal("unknown release became known", err)
			}
			if c.handle.releasedRevision != 0 {
				t.Fatal("unknown release published original revision")
			}
			before, writes, sends := ownerReadProbe(t, c), j.count(), len(b.sent)
			called := false
			if err := c.WithConversation(context.Background(), func(port.ConversationState) error { called = true; return nil }); err != Unsettled || called {
				t.Fatal("unknown owner published state", err)
			}
			assertOwnerReadUnchanged(t, c, before)
			if j.count() != writes || len(b.sent) != sends {
				t.Fatal("unknown release read retried")
			}
		})
	}
}

func TestFollowStateRequiresActualOutputCompletion(t *testing.T) {
	s, c, _, _, _ := followCompleted(t)
	// A domain result and all lifecycle receipts cannot substitute for the
	// actual semantic output completion owned by this same handle.
	s.deps.Gate.Lock()
	c.handle.output.Complete = false
	s.deps.Gate.Unlock()
	observeOK(t, c)
	if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, c, [5]bool{true, true, true, true, false})
	if _, err := s.FollowConversation(context.Background(), c, followInput()); err != Unsettled {
		t.Fatal("domain completion substituted for actual output", err)
	}
}

func TestFollowStateToolCallAndUnknownOutcomeNeverReady(t *testing.T) {
	s, c, _, _, _, correlation := relayRunning(t)
	call := relayBegin(t, c, correlation)
	assertFollowState(t, c, [5]bool{})
	if _, err := s.FollowConversation(context.Background(), c, followInput()); err != Unsettled {
		t.Fatal("outstanding tool call permitted Follow", err)
	}
	if err := call.AcknowledgeReturn(context.Background(), relayAck(correlation)); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, c, [5]bool{})
	observeOK(t, c)
	observeOK(t, c)
	if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, c, [5]bool{true, true, true, true, true})
	// Exercise the independent owning unresolved guard even if the queue has
	// no outstanding call. This injected inconsistency must never advertise Follow.
	s.deps.Gate.Lock()
	c.handle.unresolvedCallID = "unresolved-return"
	s.deps.Gate.Unlock()
	assertFollowState(t, c, [5]bool{true, true, true, true, false})
	if _, err := s.FollowConversation(context.Background(), c, followInput()); err != Unsettled {
		t.Fatal("unresolved owning tool return permitted Follow", err)
	}
	unknownOwner, b, _, _ := conversationOwner(t)
	unknown, _ := createPrepared(t, unknownOwner)
	b.sendReplyFault = "nil"
	if err := unknown.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, unknown, [5]bool{true, false, false, false, false})
	if err := unknown.Acknowledge(context.Background(), unknown.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, unknown, [5]bool{true, true, false, false, false})
	if _, err := unknownOwner.FollowConversation(context.Background(), unknown, followInput()); err != Unsettled {
		t.Fatal("unknown outcome permitted Follow", err)
	}
}

func TestFollowStateReleasedRefusalIsNotCompleted(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	c, _ := createPrepared(t, s)
	b.events = observations("user-1", "reply-1", "pear")
	b.events[2].Kind = port.Refused
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 4; n++ {
		observeOK(t, c)
	}
	if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, c, [5]bool{true, true, true, true, false})
	if _, err := s.FollowConversation(context.Background(), c, followInput()); err != Unsettled {
		t.Fatal("released refusal permitted Follow", err)
	}
}

func TestFollowStateObservingAndFrozenOwner(t *testing.T) {
	s, c, b, _, _ := followCompleted(t)
	b.observeHook = func(port.ObserveRequest) {
		called := false
		if err := c.WithConversation(context.Background(), func(port.ConversationState) error { called = true; return nil }); err != Busy || called {
			t.Fatal("observing handle published state", err)
		}
	}
	observeOK(t, c)
	if err := c.Acknowledge(context.Background(), c.handle.fixed.OperationID); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, c, [5]bool{true, true, true, true, true})
	if err := s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertFollowState(t, c, [5]bool{true, true, true, true, false})
	if _, err := s.FollowConversation(context.Background(), c, followInput()); err != Frozen {
		t.Fatal("frozen owner permitted Follow", err)
	}
	sentinel := errors.New("inspect failure")
	if err := c.WithConversation(context.Background(), func(port.ConversationState) error { return sentinel }); err != sentinel {
		t.Fatal("inspection failure changed", err)
	}
}

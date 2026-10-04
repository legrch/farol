package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Read-only CPU witnesses use the real owner and injected ports. They do not
// prove filesystem durability, physical Send, Node transport or provider receipt.
func ownerReadProbe(t *testing.T, c *Conversation) []byte {
	t.Helper()
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	view, _ := s.queue.Snapshot(identity(h.fixed))
	probe := map[string]any{"revision": s.revision, "fence": s.fence, "unknown": s.unknown, "frozen": s.frozen, "retiring": s.retiring, "pending": s.pending != nil, "retired": s.retired != nil, "view": view, "fixed": h.fixed, "registered": s.handles[h.fixed.OperationID] == h, "closed": h.closed, "observing": h.observing, "prompt": h.prompt, "sourceSequence": h.sourceSequence, "unresolved": h.unresolvedCallID, "released": h.releasedRevision, "ack": h.ackRevision, "settled": h.settledRevision, "output": h.output, "frames": h.frames.Snapshot(), "provider": c.providerID, "verification": h.verification}
	if call := h.caller; call != nil {
		probe["caller"] = map[string]any{"phase": call.phase, "claimed": call.dispatchClaimed, "request": call.request, "output": call.output, "offset": call.textOffset, "roundOpened": call.roundOpened}
	}
	encoded, err := json.Marshal(probe)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
func assertOwnerReadUnchanged(t *testing.T, c *Conversation, before []byte) {
	t.Helper()
	if !bytes.Equal(before, ownerReadProbe(t, c)) {
		t.Fatal("read mutated owner state")
	}
}
func submissionRead(t *testing.T, c *Conversation, want SubmissionState) {
	t.Helper()
	before := ownerReadProbe(t, c)
	state, err := c.SubmissionState(context.Background())
	if err != nil || state != want {
		t.Fatalf("submission=%s err=%v want=%s", state, err, want)
	}
	assertOwnerReadUnchanged(t, c, before)
}

func TestSubmissionNotDispatchedIsObservationNotWithdrawal(t *testing.T) {
	s, b, j, _ := conversationOwner(t)
	c, err := s.CreateConversation(context.Background(), input("1"))
	if err != nil {
		t.Fatal(err)
	}
	writes := j.count()
	submissionRead(t, c, SubmissionNotDispatched)
	if j.count() != writes || len(b.sent) != 0 {
		t.Fatal("queued read dispatched")
	}
	if _, err := s.PrepareNext(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	writes = j.count()
	submissionRead(t, c, SubmissionNotDispatched)
	if j.count() != writes || c.handle.closed || len(b.sent) != 0 {
		t.Fatal("prepared read withdrew or dispatched")
	}
	// This is why the consumer MUST NOT release its external replay guard from
	// not-dispatched: exactly the same live handle can still perform its Send.
	if err := c.Send(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	submissionRead(t, c, SubmissionIntentCommitted)
	if len(b.sent) != 1 {
		t.Fatal("expected one original Send")
	}
}

func TestSubmissionReadNeverInvokesPortsOrRepairsCounters(t *testing.T) {
	cases := map[string]func(*Service, *Conversation){
		"queued":             func(_ *Service, _ *Conversation) {},
		"freeze-only":        func(s *Service, _ *Conversation) { s.frozen = true },
		"unknown":            func(s *Service, _ *Conversation) { s.unknown = true },
		"pending":            func(s *Service, _ *Conversation) { s.pending = &mutation{} },
		"observing":          func(_ *Service, c *Conversation) { c.handle.observing = true },
		"retiring":           func(s *Service, _ *Conversation) { s.retiring = true },
		"retired":            func(s *Service, _ *Conversation) { s.retired = &retirementProof{} },
		"revision-exhausted": func(s *Service, _ *Conversation) { s.revision = math.MaxUint64 },
		"fence-exhausted":    func(s *Service, _ *Conversation) { s.fence = math.MaxUint64 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, _, j, _ := conversationOwner(t)
			c, err := s.CreateConversation(context.Background(), input("1"))
			if err != nil {
				t.Fatal(err)
			}
			change(s, c)
			s.deps.Journal = struct{ port.Journal }{}
			s.deps.Browser = struct{ port.VerifiedBrowser }{}
			s.deps.Results = struct{ port.ResultRetention }{}
			s.deps.IntentDigests = struct{ port.IntentDigester }{}
			want := SubmissionUnknown
			if name == "queued" || name == "freeze-only" {
				want = SubmissionNotDispatched
			}
			writes := j.count()
			submissionRead(t, c, want)
			if j.count() != writes {
				t.Fatal("read journaled")
			}
		})
	}
}

func TestSubmissionPendingSendIntentAndEffectRemainUnknown(t *testing.T) {
	for _, at := range []string{"journal", "verify"} {
		t.Run(at, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			c, _ := createPrepared(t, s)
			entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
			if at == "journal" {
				j.hook = func(w port.JournalWrite) {
					if w.Entry.Effect == "send" {
						close(entered)
						<-release
					}
				}
			} else {
				b.verifyHook = func(*port.SendVerification) { close(entered); <-release }
			}
			go func() { done <- c.Send(context.Background(), 100) }()
			<-entered
			submissionRead(t, c, SubmissionUnknown)
			close(release)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			submissionRead(t, c, SubmissionIntentCommitted)
			if len(b.sent) != 1 {
				t.Fatal("read repeated Send")
			}
		})
	}
}

func TestSubmissionLostReplyNotSentAndKnownCancellation(t *testing.T) {
	for _, kind := range []string{"lost-send", "known-not-sent", "cancel-before", "cancel-after", "lost-prepare-journal"} {
		t.Run(kind, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			c, err := s.CreateConversation(context.Background(), input("1"))
			if err != nil {
				t.Fatal(err)
			}
			want := SubmissionUnknown
			switch kind {
			case "lost-prepare-journal":
				j.fault = "nil"
				if _, err := s.PrepareNext(context.Background(), 100); err == nil {
					t.Fatal("lost journal reply treated as known")
				}
			case "cancel-before":
				if err := c.Cancel(context.Background()); err != nil {
					t.Fatal(err)
				}
				want = SubmissionNotDispatched
			default:
				if _, err := s.PrepareNext(context.Background(), 100); err != nil {
					t.Fatal(err)
				}
				if kind == "lost-send" {
					b.sendReplyFault = "nil"
				}
				if kind == "known-not-sent" {
					b.sendReplyFault = "not-sent"
					want = SubmissionIntentCommitted
				}
				if err := c.Send(context.Background(), 100); err != nil {
					t.Fatal(err)
				}
				if kind == "cancel-after" {
					if err := c.Cancel(context.Background()); err != nil {
						t.Fatal(err)
					}
				}
			}
			writes, sends := j.count(), len(b.sent)
			submissionRead(t, c, want)
			if j.count() != writes || len(b.sent) != sends {
				t.Fatal("read caused effect")
			}
			// Even a confirmed NotSent reply follows a committed intent. This
			// observation never deletes external deduplication or starts a retry.
			if err := c.Send(context.Background(), 100); err == nil {
				t.Fatal("terminal/unknown Send repeated")
			}
			if len(b.sent) != sends {
				t.Fatal("new physical send")
			}
		})
	}
}

func TestSubmissionRejectsForgedAndWithdrawnContexts(t *testing.T) {
	for _, kind := range []string{"nil-conversation", "empty-conversation", "nil-context", "cancelled-context", "owner-registry", "conversation-owner"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _, _ := conversationOwner(t)
			c, err := s.CreateConversation(context.Background(), input("1"))
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			switch kind {
			case "nil-conversation":
				c = nil
			case "empty-conversation":
				c = &Conversation{}
			case "nil-context":
				ctx = nil
			case "cancelled-context":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "owner-registry":
				delete(s.handles, c.handle.fixed.OperationID)
			case "conversation-owner":
				c.handle.conversation = &Conversation{}
			}
			state, err := c.SubmissionState(ctx)
			if err == nil || state != SubmissionUnknown {
				t.Fatal("forged/withdrawn request produced known state")
			}
		})
	}
}

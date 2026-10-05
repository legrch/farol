package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Pure lifecycle fixtures only: no native, filesystem, provider or transport
// evidence. Literal oracle sizes intentionally do not use production limits.
type conversationByteCorpus struct{ name, prefix, unit string }

func conversationByteCorpora() []conversationByteCorpus {
	return []conversationByteCorpus{
		{"ASCII", "Ready: ", "a"},
		{"Cyrillic", "Ответ: ", "я"},
		{"emoji", "Ready 😀: ", "😀"},
		{"escaped_control", "Ready:\n", "\x00"},
	}
}

func conversationByteText(t *testing.T, corpus conversationByteCorpus, size int) string {
	t.Helper()
	remaining := size - len(corpus.prefix)
	// Put ASCII padding before the repeated unit so a multibyte overflow ends
	// in a whole Cyrillic/emoji rune, rather than merely an ASCII extra byte.
	text := corpus.prefix + strings.Repeat("x", remaining%len(corpus.unit)) + strings.Repeat(corpus.unit, remaining/len(corpus.unit))
	if len(text) != size || !utf8.ValidString(text) {
		t.Fatalf("invalid byte oracle: size=%d got=%d UTF-8=%v", size, len(text), utf8.ValidString(text))
	}
	return text
}

func TestConversationPromptByteBoundaries(t *testing.T) {
	for _, corpus := range conversationByteCorpora() {
		for _, size := range []int{8191, 8192, 8193} {
			t.Run(fmt.Sprintf("%s/%d", corpus.name, size), func(t *testing.T) {
				s, browser, journal, retained := conversationOwner(t)
				ctx := context.Background()
				in := input("1")
				in.Prompt = conversationByteText(t, corpus, size)
				writes := journal.count()
				c, err := s.CreateConversation(ctx, in)
				if size == 8193 {
					if c != nil || !errors.Is(err, Invalid) {
						t.Fatalf("oversized prompt admitted: conversation=%p err=%v", c, err)
					}
					if journal.count() != writes || len(browser.prepares) != 0 || len(browser.verifies) != 0 || len(browser.sent) != 0 || retained.calls != 0 {
						t.Fatal("prompt refusal occurred after journal/browser/retention effects")
					}
					// A valid subsequent admission proves refusal did not fence the owner.
					if next, err := s.CreateConversation(ctx, input("1")); err != nil || next == nil {
						t.Fatalf("refused prompt poisoned admission: conversation=%p err=%v", next, err)
					}
					return
				}
				if err != nil || c == nil {
					t.Fatalf("valid prompt refused: conversation=%p err=%v", c, err)
				}
				if _, err := s.PrepareNext(ctx, 100); err != nil {
					t.Fatal(err)
				}
				if err := c.Send(ctx, 100); err != nil {
					t.Fatal(err)
				}
				if len(browser.sent) != 1 || len(browser.verifies) != 1 || len(browser.prepares) != 1 {
					t.Fatalf("adapter calls: prepare=%d verify=%d send=%d", len(browser.prepares), len(browser.verifies), len(browser.sent))
				}
				if got := browser.sent[0].Prompt; len(got) != size || !bytes.Equal([]byte(got), []byte(in.Prompt)) {
					t.Fatalf("Send changed prompt bytes: want=%d got=%d", size, len(got))
				}
				if retained.calls != 0 {
					t.Fatal("Send invented an output result")
				}
			})
		}
	}
}

// The adapter initially knows only Accepted plus the useful prefix. The rest of
// the answer is appended by the test only after actual public delta delivery.
func conversationBytePrefix(t *testing.T, s *Service, browser *conversationBrowser, retained *resultFixture, prefix string) (*Conversation, []stream.Frame, *int) {
	t.Helper()
	ctx := context.Background()
	c, _ := createPrepared(t, s)
	observed := new(int)
	browser.observeHook = func(r port.ObserveRequest) {
		*observed++
		if r.Limit != 1 || r.AfterSequence != uint64(*observed-1) {
			t.Fatalf("unexpected observation request: %+v", r)
		}
	}
	browser.events = []port.BrowserObservation{
		{Kind: port.Accepted, UserTurnID: "byte-user"},
		{Kind: port.AnswerDelta, UserTurnID: "byte-user", ReplyID: "byte-reply", SegmentID: "prefix", Text: prefix},
	}
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	observeOK(t, c)
	frames, err := c.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 4 || conversationByteDeltas(t, frames) != prefix {
		t.Fatal("useful prefix was not delivered through output_text.delta")
	}
	for _, frame := range frames {
		if frame.Kind == stream.Terminal {
			t.Fatal("prefix delivery published a terminal")
		}
	}
	if result, err := c.Result(ctx); result != nil || !errors.Is(err, Unsettled) || retained.calls != 0 || len(retained.payload) != 0 {
		t.Fatalf("prefix became retained success: result=%+v err=%v retains=%d", result, err, retained.calls)
	}
	if err := c.WithConversation(ctx, func(state port.ConversationState) error {
		if state.HasResult || state.DeliveryAcknowledged || state.LifecycleSettled || state.FollowReady || state.Released {
			t.Fatalf("prefix became settled: %+v", state)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return c, frames, observed
}

func conversationByteDeltas(t *testing.T, frames []stream.Frame) string {
	t.Helper()
	var text strings.Builder
	for _, frame := range frames {
		var body struct{ Type, Delta string }
		if err := json.Unmarshal(frame.Data, &body); err != nil {
			t.Fatal(err)
		}
		if body.Type == "response.output_text.delta" {
			if frame.Kind != stream.Delta {
				t.Fatal("output_text.delta has incorrect frame kind")
			}
			text.WriteString(body.Delta)
		}
	}
	return text.String()
}

func conversationByteAppend(browser *conversationBrowser, remainder string) {
	browser.events = append(browser.events,
		port.BrowserObservation{Kind: port.AnswerDelta, UserTurnID: "byte-user", ReplyID: "byte-reply", SegmentID: "remainder", Text: remainder},
		port.BrowserObservation{Kind: port.Completed, UserTurnID: "byte-user", ReplyID: "byte-reply"},
		port.BrowserObservation{Kind: port.Quiescent, UserTurnID: "byte-user", ReplyID: "byte-reply"},
	)
}

func TestConversationOutputByteBoundaries(t *testing.T) {
	for _, corpus := range conversationByteCorpora() {
		for _, size := range []int{8191, 8192, 8193} {
			t.Run(fmt.Sprintf("%s/%d", corpus.name, size), func(t *testing.T) {
				s, browser, journal, retained := conversationOwner(t)
				text := conversationByteText(t, corpus, size)
				c, early, observed := conversationBytePrefix(t, s, browser, retained, corpus.prefix)
				conversationByteAppend(browser, text[len(corpus.prefix):])
				if size == 8193 {
					conversationByteOverflow(t, s, c, browser, journal, retained, corpus.prefix, early, observed)
					return
				}
				ctx := context.Background()
				observeOK(t, c)
				frames, err := c.Events(ctx, 0)
				if err != nil || conversationByteDeltas(t, frames) != text {
					t.Fatalf("incremental output changed bytes: err=%v", err)
				}
				if result, err := c.Result(ctx); result != nil || !errors.Is(err, Unsettled) || retained.calls != 0 {
					t.Fatal("full text without Completed became success")
				}
				var captured port.RetainRequest
				retained.hook = func(r port.RetainRequest) { captured = r }
				observeOK(t, c)
				result, err := c.Result(ctx)
				if err != nil || result == nil || !result.Complete || result.Outcome != string(turn.Completed) || result.Code != "PROVIDER_COMPLETED" || result.Acknowledged || len(result.Text) != size || result.Text != text {
					t.Fatalf("terminal result changed bytes/outcome: size=%d result=%+v err=%v", size, result, err)
				}
				if retained.calls != 1 || len(retained.payload) != size || !bytes.Equal(retained.payload, []byte(text)) || !bytes.Equal(captured.Payload, []byte(text)) || captured.Result.Outcome != turn.Completed || captured.Result.ID != result.ResultID || !captured.Conversation.Complete || !captured.Conversation.Valid(captured.Result, captured.Payload) {
					t.Fatal("retained terminal does not preserve the exact output bytes")
				}
				frames, err = c.Events(ctx, 0)
				if err != nil || len(frames) != 9 || conversationByteDeltas(t, frames) != text {
					t.Fatalf("completed stream: frames=%d err=%v", len(frames), err)
				}
				var terminal struct {
					Type     string
					Response struct {
						Status string
						Output []struct{ Content []struct{ Type, Text string } }
					}
				}
				last := frames[len(frames)-1]
				if err := json.Unmarshal(last.Data, &terminal); err != nil {
					t.Fatal(err)
				}
				if last.Kind != stream.Terminal || terminal.Type != "response.completed" || terminal.Response.Status != "completed" || len(terminal.Response.Output) != 1 || len(terminal.Response.Output[0].Content) != 1 || terminal.Response.Output[0].Content[0].Type != "output_text" || terminal.Response.Output[0].Content[0].Text != text {
					t.Fatal("completed event lost exact text")
				}
				if corpus.name == "escaped_control" && len(last.Data) <= size {
					t.Fatal("control fixture did not exercise encoded frame expansion")
				}
				if len(browser.sent) != 1 || *observed != 4 {
					t.Fatalf("completion performed extra adapter work: sends=%d observations=%d", len(browser.sent), *observed)
				}
			})
		}
	}
}

func conversationByteOverflow(t *testing.T, s *Service, c *Conversation, browser *conversationBrowser, journal *journalFixture, retained *resultFixture, prefix string, early []stream.Frame, observed *int) {
	t.Helper()
	ctx := context.Background()
	writes := journal.count()
	before, err := s.queue.Snapshot(identity(c.handle.fixed))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Observe(ctx, 100); !errors.Is(err, Unsettled) {
		t.Fatalf("overflow did not fence observation: %v", err)
	}
	if result, err := c.Result(ctx); result != nil || !errors.Is(err, Unsettled) {
		t.Fatalf("overflow exposed truncated success: result=%+v err=%v", result, err)
	}
	if frames, err := c.Events(ctx, 0); frames != nil || !errors.Is(err, Unsettled) {
		t.Fatalf("overflow exposed a stream after owner fencing: frames=%d err=%v", len(frames), err)
	}
	called := false
	if err := c.WithConversation(ctx, func(port.ConversationState) error { called = true; return nil }); !errors.Is(err, Unsettled) || called {
		t.Fatal("overflow granted a settled conversation projection")
	}
	if err := c.handle.WithCurrent(ctx, func(current *port.CurrentTurn) error {
		if current == nil || current.Persistence != port.UnknownCommit || current.Turn.HasResult || current.Turn.DeliveryAcknowledged || current.Turn.LifecycleSettled {
			t.Fatalf("overflow misrepresented unknown persistence: %+v", current)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if next, err := s.FollowConversation(ctx, c, followInput()); next != nil || !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted Follow: conversation=%p err=%v", next, err)
	}
	if err := c.Acknowledge(ctx, c.handle.fixed.OperationID); !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted result ACK: %v", err)
	}
	if ack, err := c.AcknowledgeFrame(ctx, early[len(early)-1].Sequence); ack != "" || !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted frame ACK: ack=%s err=%v", ack, err)
	}
	if err := c.Observe(ctx, 100); !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted observation retry: %v", err)
	}
	if err := c.Resume(ctx); !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted Resume: %v", err)
	}
	if err := c.Send(ctx, 100); !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted replacement Send: %v", err)
	}
	if binding, err := s.PrepareNext(ctx, 100); binding != nil || !errors.Is(err, Unsettled) {
		t.Fatalf("overflow granted Prepare: binding=%+v err=%v", binding, err)
	}
	for _, in := range []port.ConversationInput{input("1"), input("2")} {
		if next, err := s.CreateConversation(ctx, in); next != nil || !errors.Is(err, Unsettled) {
			t.Fatalf("overflow granted replay/replacement admission: conversation=%p err=%v", next, err)
		}
	}
	// Public methods truthfully refuse reads after fencing. Inspect only the
	// already committed candidate to exclude hidden terminal/truncated publication.
	after, err := s.queue.Snapshot(identity(c.handle.fixed))
	stored, frameErr := c.handle.frames.After(streamScope(c.handle.fixed), 0)
	if err != nil || frameErr != nil || before != after || !reflect.DeepEqual(stored, early) || c.handle.frames.Snapshot().Terminal || c.handle.output.Text() != prefix || c.handle.output.Complete || c.handle.sourceSequence != 2 || c.handle.releasedRevision != 0 || !s.unknown {
		t.Fatalf("overflow changed committed state: snapshot=%v frames=%v", err, frameErr)
	}
	if journal.count() != writes || retained.calls != 0 || len(retained.payload) != 0 || len(browser.prepares) != 1 || len(browser.verifies) != 1 || len(browser.sent) != 1 || *observed != 3 {
		t.Fatalf("overflow/retry performed effects: writes=%d/%d retains=%d prepares=%d verifies=%d sends=%d observations=%d", journal.count(), writes, retained.calls, len(browser.prepares), len(browser.verifies), len(browser.sent), *observed)
	}
}

func TestConversationEscapedFrameByteBudget(t *testing.T) {
	s, browser, journal, retained := conversationOwner(t)
	corpus := conversationByteCorpora()[3]
	text := conversationByteText(t, corpus, 8192)
	c, early, observed := conversationBytePrefix(t, s, browser, retained, corpus.prefix)
	// A bounded white-box budget injects a narrower delivery frame capacity;
	// raw output still fits 8192 bytes, but each NUL encodes as six JSON bytes.
	buffer, err := stream.New(streamScope(c.handle.fixed), stream.Limits{Frames: 128, FrameBytes: 8192, Bytes: 65536})
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range early {
		if _, err := buffer.Append(frame.Kind, frame.Data); err != nil {
			t.Fatal(err)
		}
	}
	c.handle.frames = buffer
	encoded, err := json.Marshal(text[len(corpus.prefix):])
	if err != nil || len(encoded) <= 8192 {
		t.Fatalf("fixture did not exceed encoded frame budget: bytes=%d err=%v", len(encoded), err)
	}
	conversationByteAppend(browser, text[len(corpus.prefix):])
	conversationByteOverflow(t, s, c, browser, journal, retained, corpus.prefix, early, observed)
}

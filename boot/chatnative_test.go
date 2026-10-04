//go:build darwin

package boot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
	"golang.org/x/sys/unix"
)

// The ordinary CLI parser/registry, actual native stores, Chat service, browser
// adapter and canonical pipe exchange run here. The peer is a controlled browser
// double with a controlled saved conversation, not a real page/new-chat proof.
// No Electron, child executable, provider, package, restart or containment claim.
type chatNativePeer struct {
	t       *testing.T
	sender  *io.PipeWriter
	receive <-chan wire.Response
	pending map[string]wire.Response
	peer    *wire.Context
	count   int
}

func (p *chatNativePeer) start(method string, body any, effect bool) string {
	p.t.Helper()
	p.count++
	id := fmt.Sprintf("request-%d", p.count)
	raw, e := json.Marshal(body)
	if e != nil {
		p.t.Fatal(e)
	}
	req := wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: wire.Call{Context: p.peer, Body: raw}}
	if effect {
		op := "effect-" + id
		req.Params.OperationId = &op
	}
	if method == "chat.browser.reply" {
		var reply wire.BrowserReply
		if json.Unmarshal(raw, &reply) != nil {
			p.t.Fatal("reply fixture")
		}
		req.Params.OperationId = &reply.CommandId
	}
	data, e := json.Marshal(req)
	if e != nil {
		p.t.Fatal(e)
	}
	wrote := make(chan error, 1)
	go func() { wrote <- ipc.WriteFrame(p.sender, data) }()
	select {
	case e := <-wrote:
		if e != nil {
			p.t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		p.t.Fatal("normal pipe write blocked; no replay")
	}
	return id
}
func (p *chatNativePeer) await(id string) wire.Outcome {
	p.t.Helper()
	for {
		if r, ok := p.pending[id]; ok {
			delete(p.pending, id)
			if r.Error != nil || r.Result == nil {
				p.t.Fatalf("protocol failure: %+v", r)
			}
			return *r.Result
		}
		select {
		case r, ok := <-p.receive:
			if !ok {
				p.t.Fatal("normal pipe ended")
			}
			if r.Id == nil {
				p.t.Fatal("uncorrelated protocol reply")
			}
			p.pending[*r.Id] = r
		case <-time.After(4 * time.Second):
			p.t.Fatal("normal pipe reply unknown; no replay")
		}
	}
}
func (p *chatNativePeer) ok(method string, body any, effect bool) wire.Outcome {
	p.t.Helper()
	r := p.await(p.start(method, body, effect))
	if r.Status != "ok" {
		p.t.Fatalf("%s: %+v", method, r)
	}
	return r
}
func chatNativeFixture(t *testing.T) *chatNativePeer {
	t.Helper()
	if !*ingressNative {
		t.Skip("Requires exclusive native lane and -ingress-native")
	}
	parent := filepath.Join("..", "_output", "tmp")
	if e := os.MkdirAll(parent, 0700); e != nil {
		t.Fatal(e)
	}
	root, e := os.MkdirTemp(parent, "chat-normal-")
	if e != nil {
		t.Fatal(e)
	}
	root, e = filepath.EvalSymlinks(root)
	if e != nil {
		t.Fatal(e)
	}
	root, e = filepath.Abs(root)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("Owned disposable fixture: %s", root)
	for _, path := range []string{"profile", "profile/computer", "profile/chat", "profile/task", "home"} {
		if e := os.Mkdir(filepath.Join(root, path), 0700); e != nil {
			t.Fatal(e)
		}
	}
	profile := filepath.Join(root, "profile")
	var st unix.Stat_t
	if e := unix.Lstat(profile, &st); e != nil {
		t.Fatal(e)
	}
	input, sender := io.Pipe()
	receiver, output := io.Pipe()
	responses := make(chan wire.Response, 16)
	readDone := make(chan struct{})
	done := make(chan int, 1)
	var diagnostics bytes.Buffer
	go func() {
		defer close(readDone)
		defer close(responses)
		for {
			raw, e := ipc.ReadFrame(receiver)
			if e != nil {
				return
			}
			var r wire.Response
			if json.Unmarshal(raw, &r) != nil {
				return
			}
			responses <- r
		}
	}()
	go func() {
		done <- Run([]string{"serve", "--profile", "fixture", "--profile-root", profile, "--profile-device", fmt.Sprint(st.Dev), "--profile-inode", fmt.Sprint(st.Ino), "--owner", "owner", "--computer", "computer", "--home", filepath.Join(root, "home"), "--store-mode", "create"}, input, output, &diagnostics)
	}()
	t.Cleanup(func() {
		_ = sender.Close()
		_ = receiver.Close()
		select {
		case code := <-done:
			if code != 0 {
				t.Errorf("CLI terminal %d: %s", code, diagnostics.String())
			}
		case <-time.After(5 * time.Second):
			t.Error("CLI terminal unconfirmed; fixture retained")
		}
		select {
		case <-readDone:
		case <-time.After(time.Second):
			t.Error("pipe reader unconfirmed")
		}
		if !t.Failed() {
			if e := os.RemoveAll(root); e != nil {
				t.Error(e)
			}
		}
	})
	p := &chatNativePeer{t: t, sender: sender, receive: responses, pending: make(map[string]wire.Response)}
	hello := p.ok("core.handshake", wire.Handshake{ProtocolMajor: 1, ProtocolMinor: 0, BuildId: BuildID, ProfileId: "fixture"}, false)
	p.peer = &hello.Context
	return p
}
func decodeChat[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var out T
	if e := json.Unmarshal(raw, &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func nativeChatInput() wire.ChatCreate {
	selection := wire.BrowserSelection{Provider: "farol", Alias: "chatgpt", AccountId: "controlled-account", ModelId: "controlled-model", Effort: "low", Mode: "standard"}
	return wire.ChatCreate{Required: wire.BrowserRequiredControls{Model: true, Effort: true, Mode: true}, SessionId: "session", Prompt: "Synthetic controlled input", Selection: selection, Resolution: wire.BrowserResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", RequestedMode: "standard", ConfigSHA256: strings.Repeat("a", 64), TranslationId: "configured", Resolved: selection}}
}
func (p *chatNativePeer) exchange(reply func(wire.BrowserCommand) any) {
	p.t.Helper()
	next := p.ok("chat.browser.next", wire.BrowserNext{DeadlineMillis: decimal(uint64(time.Now().Add(2 * time.Second).UnixMilli()))}, false)
	command := decodeChat[wire.BrowserNextResult](p.t, next.Data).Command
	if command == nil {
		p.t.Fatal("missing reciprocal browser command")
	}
	body, e := json.Marshal(reply(*command))
	if e != nil {
		p.t.Fatal(e)
	}
	p.ok("chat.browser.reply", wire.BrowserReply{CommandId: command.CommandId, Kind: command.Kind, Body: body}, true)
}
func (p *chatNativePeer) prepare() wire.ChatPrepared {
	p.t.Helper()
	id := p.start("chat.conversation.prepare", wire.ChatDeadline{DeadlineMillis: decimal(uint64(time.Now().Add(3 * time.Second).UnixMilli()))}, true)
	p.exchange(func(c wire.BrowserCommand) any {
		if c.Kind != "prepare" {
			p.t.Fatal(c.Kind)
		}
		r := decodeChat[wire.BrowserPrepare](p.t, c.Body)
		cid := "controlled-provider-conversation"
		if r.Target.Mode == "owned-saved" && r.Target.ConversationId != cid {
			p.t.Fatal("follow-up changed conversation")
		}
		state := "bound"
		if r.Target.Mode == "new-saved" {
			state = "home"
			cid = ""
		}
		return wire.BrowserPrepared{Saved: state == "bound", Readiness: "ready", Binding: wire.BrowserBinding{ProviderState: state, Lease: r.Lease, ViewId: "controlled-view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationId: cid}}
	})
	out := p.await(id)
	if out.Status != "ok" {
		p.t.Fatalf("prepare: %+v", out)
	}
	return decodeChat[wire.ChatPrepared](p.t, out.Data)
}
func (p *chatNativePeer) send(handle string, lostACK bool, attempted, accepted *int) wire.Outcome {
	p.t.Helper()
	id := p.start("chat.conversation.send", wire.ChatAction{HandleId: handle, DeadlineMillis: decimal(uint64(time.Now().Add(3 * time.Second).UnixMilli()))}, true)
	p.exchange(func(c wire.BrowserCommand) any {
		if c.Kind != "verify-send" {
			p.t.Fatal(c.Kind)
		}
		r := decodeChat[wire.BrowserVerifySend](p.t, c.Body)
		return wire.BrowserVerified{Verification: wire.BrowserVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: controlledWireFacts(r.Requested), PreviousUserTurnId: r.PreviousUserTurnId, PreviousReplyId: r.PreviousReplyId, IntentDigest: r.IntentDigest, EvidenceId: "proof-" + r.Binding.Lease.Identity.OperationId}}
	})
	p.exchange(func(c wire.BrowserCommand) any {
		if c.Kind != "send" {
			p.t.Fatal(c.Kind)
		}
		r := decodeChat[wire.BrowserSend](p.t, c.Body)
		*attempted++
		*accepted++
		status := "submitted"
		if lostACK {
			status = "unknown"
		}
		return wire.BrowserSent{Binding: r.Binding, VerificationId: r.Verification.EvidenceId, Status: status}
	})
	return p.await(id)
}
func (p *chatNativePeer) observe(handle, kind string) {
	p.t.Helper()
	id := p.start("chat.conversation.observe", wire.ChatAction{HandleId: handle, DeadlineMillis: decimal(uint64(time.Now().Add(3 * time.Second).UnixMilli()))}, true)
	p.exchange(func(c wire.BrowserCommand) any {
		r := decodeChat[wire.BrowserObserve](p.t, c.Body)
		e := wire.BrowserObservation{Binding: r.Binding, Sequence: decimal(wireUint(r.AfterSequence) + 1), ObservedAtMillis: decimal(uint64(time.Now().UnixMilli())), Kind: kind, UserTurnId: "user-" + r.Binding.Lease.Identity.TurnId, ReplyId: "reply-" + r.Binding.Lease.Identity.TurnId}
		if kind == "accepted" && r.Binding.ProviderState == "home" {
			e.ProviderConversationId = "controlled-provider-conversation"
		}
		if kind == "answer-delta" {
			e.Text = "Useful incremental controlled text"
			e.SegmentId = "segment-1"
		}
		return wire.BrowserObserved{Events: []wire.BrowserObservation{e}}
	})
	if out := p.await(id); out.Status != "ok" {
		p.t.Fatalf("observe %s: %+v", kind, out)
	}
}
func TestNativeCLIChatStreamsBeforeCompletionAndFollowsSameConversation(t *testing.T) {
	p := chatNativeFixture(t)
	input := nativeChatInput()
	first := decodeChat[wire.ChatHandle](t, p.ok("chat.conversation.create", input, true).Data)
	if out := p.await(p.start("chat.conversation.prepare", wire.ChatDeadline{DeadlineMillis: "0"}, true)); out.Status != "refused" {
		t.Fatal("expired prepare was not refused before queue mutation")
	}
	prepared := p.prepare()
	if prepared.Handle.HandleId != first.HandleId {
		t.Fatal("wrong prepare owner")
	}
	attempted, accepted := 0, 0
	if out := p.send(first.HandleId, false, &attempted, &accepted); out.Status != "ok" {
		t.Fatal(out)
	}
	p.observe(first.HandleId, "accepted")
	p.observe(first.HandleId, "answer-delta")
	frames := decodeChat[wire.ChatFrames](t, p.ok("chat.conversation.events", wire.ChatEventsRequest{HandleId: first.HandleId, AfterSequence: "0"}, false).Data)
	useful := false
	for _, f := range frames.Frames {
		if f.Kind == "response.completed" {
			t.Fatal("premature terminal")
		}
		if f.Kind == "response.output_text.delta" && bytes.Contains(f.Data, []byte("Useful incremental")) {
			useful = true
		}
	}
	if !useful {
		t.Fatal("no useful stream before terminal")
	}
	for _, f := range frames.Frames {
		p.ok("chat.conversation.frame.ack", wire.ChatFrameAck{HandleId: first.HandleId, Sequence: f.Sequence}, true)
	}
	p.observe(first.HandleId, "completed")
	result := decodeChat[wire.ChatResult](t, p.ok("chat.conversation.result", wire.ChatHandleRequest{HandleId: first.HandleId}, false).Data)
	if !result.Complete || result.Acknowledged || result.Text != "Useful incremental controlled text" {
		t.Fatalf("result: %+v", result)
	}
	if result.Evidence.ObservationSource != "field-facts" || result.Evidence.Observed == nil {
		t.Fatal("missing observed evidence")
	}
	p.ok("chat.conversation.result.ack", wire.ChatResultAck{HandleId: first.HandleId, ResultId: result.ResultId}, true)
	p.observe(first.HandleId, "quiescent")
	input.PreviousHandle = &first.HandleId
	input.Prompt = "Synthetic follow-up"
	second := decodeChat[wire.ChatHandle](t, p.ok("chat.conversation.create", input, true).Data)
	if second.Binding.TaskId != first.Binding.TaskId || second.Binding.TurnId == first.Binding.TurnId || second.Binding.TurnGeneration != "2" {
		t.Fatal("follow-up identity changed")
	}
	again := p.prepare()
	if prepared.ProviderState != "home" || prepared.ConversationId != "" || again.ProviderState != "bound" || again.ConversationId != result.ConversationId || result.ConversationId != "controlled-provider-conversation" {
		t.Fatal("conversation changed")
	}
	if out := p.send(second.HandleId, false, &attempted, &accepted); out.Status != "ok" {
		t.Fatal(out)
	}
	if attempted != 2 || accepted != 2 {
		t.Fatal("duplicate send")
	}
	p.ok("chat.conversation.result", wire.ChatHandleRequest{HandleId: first.HandleId}, false)
	if attempted != 2 {
		t.Fatal("retained read resent")
	}
	t.Logf("Controlled peer ledger attempted=%d accepted=%d; useful delta preceded terminal; same provider conversation", attempted, accepted)
}
func TestNativeCLIChatUnknownAcceptanceCannotSendAgain(t *testing.T) {
	p := chatNativeFixture(t)
	h := decodeChat[wire.ChatHandle](t, p.ok("chat.conversation.create", nativeChatInput(), true).Data)
	p.prepare()
	attempted, accepted := 0, 0
	_ = p.send(h.HandleId, true, &attempted, &accepted)
	out := p.await(p.start("chat.conversation.send", wire.ChatAction{HandleId: h.HandleId, DeadlineMillis: decimal(uint64(time.Now().Add(time.Second).UnixMilli()))}, true))
	if out.Status == "ok" {
		t.Fatal("unknown Send accepted again")
	}
	if attempted != 1 || accepted != 1 {
		t.Fatal("duplicate send")
	}
	next := p.ok("chat.browser.next", wire.BrowserNext{DeadlineMillis: decimal(uint64(time.Now().Add(20 * time.Millisecond).UnixMilli()))}, false)
	if decodeChat[wire.BrowserNextResult](t, next.Data).Command != nil {
		t.Fatal("unknown Send queued physical retry")
	}
	t.Logf("Controlled lost-ACK ledger attempted=%d accepted=%d; second Send caused no physical command", attempted, accepted)
}

// These facts are the explicit controlled peer oracle, not real DOM evidence.
func controlledWireFacts(s wire.BrowserSelection) wire.BrowserSelectionFacts {
	fact := func(v string) wire.BrowserControlFact {
		if v == "" {
			return wire.BrowserControlFact{Source: "unknown"}
		}
		return wire.BrowserControlFact{Source: "public-control", Value: v, Literal: v}
	}
	return wire.BrowserSelectionFacts{Model: fact(s.ModelId), Effort: fact(s.Effort), Mode: fact(s.Mode), Connector: fact(s.ConnectorId), ObservedAtMillis: decimal(uint64(time.Now().UnixMilli()))}
}

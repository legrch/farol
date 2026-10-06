package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

const idleNonce = "a0000000-0000-4000-8000-000000000001"

func idleServer(t *testing.T) *Server {
	t.Helper()
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{
		"chat.browser.next": {Handle: func(context.Context, Request) (*Outcome, error) {
			return &Outcome{Status: "ok", Data: json.RawMessage(`{"command":null}`)}, nil
		}},
		"computer.settings.store.next": {Handle: func(context.Context, Request) (*Outcome, error) {
			return &Outcome{Status: "ok", Data: json.RawMessage(`{"command":null}`)}, nil
		}},
		"core.retirement.prepare": {Handle: func(context.Context, Request) (*Outcome, error) {
			return &Outcome{Status: "ok", Data: json.RawMessage(`{}`)}, nil
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestIdlePollLifetimeRetainsBoundedHistoryAndRetirement(t *testing.T) {
	s := idleServer(t)
	ctx := s.context()
	var frames bytes.Buffer
	appendFrame := func(raw []byte) {
		t.Helper()
		if err := ipc.WriteFrame(&frames, raw); err != nil {
			t.Fatal(err)
		}
	}
	appendFrame(request("hello", "core.handshake", `{"protocolMajor":1,"protocolMinor":0,"buildId":"build","profileId":"test"}`, nil))
	for i := 1; i <= 6000; i++ {
		for _, poll := range []struct{ lane, method string }{{"browser", "chat.browser.next"}, {"settings", "computer.settings.store.next"}} {
			appendFrame(request(fmt.Sprintf("desktop-poll-%s:%s:%d", poll.lane, idleNonce, i), poll.method, `{"deadlineMillis":"1"}`, &ctx))
		}
	}
	// An effect still gets its unchanged operation ID and its replay fence.
	var retire wire.Request
	if err := json.Unmarshal(request("retire", "core.retirement.prepare", `{}`, &ctx), &retire); err != nil {
		t.Fatal(err)
	}
	retire.Params.OperationId = optional("original-retirement")
	data, err := json.Marshal(retire)
	if err != nil {
		t.Fatal(err)
	}
	appendFrame(data)
	appendFrame(data)
	out := &bufferWriter{}
	if err := s.Serve(context.Background(), io.NopCloser(bytes.NewReader(frames.Bytes())), out); err != nil {
		t.Fatal(err)
	}
	count := 0
	for out.Len() > 0 {
		raw, err := ipc.ReadFrame(out)
		if err != nil {
			t.Fatal(err)
		}
		var response wire.Response
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Fatal(err)
		}
		count++
		if count == 12003 {
			if response.Error == nil || response.Error.Message != "duplicate request ID" {
				t.Fatal("retirement replay admitted")
			}
		} else if response.Result == nil || response.Result.Status != "ok" {
			t.Fatalf("response %d: %+v", count, response)
		}
	}
	if count != 12003 || len(s.seen) != 2 || len(s.polls) != 2 {
		t.Fatalf("unbounded/lost history: responses=%d ordinary=%d polls=%d", count, len(s.seen), len(s.polls))
	}
}

func TestOrderedPollCannotReplayCrossContextOrCarryAnEffect(t *testing.T) {
	s := idleServer(t)
	handshake(s)
	ctx := s.context()
	id := "desktop-poll-browser:" + idleNonce + ":1"
	if response := s.dispatch(context.Background(), request(id, "chat.browser.next", `{"deadlineMillis":"1"}`, &ctx)); response.Result == nil || !s.pollAdmitted {
		t.Fatal("first poll refused")
	}
	for _, item := range []struct {
		id, method, body string
		context          wire.Context
	}{
		{id, "chat.browser.next", `{"deadlineMillis":"1"}`, ctx},
		{"desktop-poll-browser:" + idleNonce + ":3", "chat.browser.next", `{"deadlineMillis":"1"}`, ctx},
		{"desktop-poll-browser:" + idleNonce + ":2", "core.status", `{}`, ctx},
		{"desktop-poll-browser:" + idleNonce + ":2", "chat.browser.next", `{"deadlineMillis":"1"}`, wire.Context{ProfileId: "test", BackendGeneration: "stale"}},
		{"desktop-poll-browser:" + idleNonce + ":2", "chat.browser.next", `{}`, ctx},
		{"desktop-poll-browser:a0000000-0000-4000-8000-000000000002:2", "chat.browser.next", `{"deadlineMillis":"1"}`, ctx},
	} {
		if response := s.dispatch(context.Background(), request(item.id, item.method, item.body, &item.context)); response.Error == nil || s.pollAdmitted {
			t.Fatalf("invalid poll admitted: %+v", item)
		}
	}
	var forged wire.Request
	json.Unmarshal(request("desktop-poll-browser:"+idleNonce+":2", "chat.browser.next", `{"deadlineMillis":"1"}`, &ctx), &forged)
	forged.Params.OperationId = optional("not-read-only")
	raw, _ := json.Marshal(forged)
	if response := s.dispatch(context.Background(), raw); response.Error == nil || s.pollAdmitted {
		t.Fatal("effect correlation admitted as a poll")
	}
	if response := s.dispatch(context.Background(), request("desktop-poll-browser:"+idleNonce+":2", "chat.browser.next", `{"deadlineMillis":"1"}`, &ctx)); response.Result == nil {
		t.Fatal("invalid attempts consumed the valid sequence")
	}
}

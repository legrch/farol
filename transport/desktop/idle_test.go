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
const idleHealthBody = `{"binding":{"buildId":"build","profileId":"test","backendGeneration":"generation","runtimeId":"runtime","connectorGeneration":"1"},"expectedInstanceId":"instance"}`

// In-memory framed server fixture only; no native process, socket or provider.
func idleServer(t *testing.T) *Server {
	t.Helper()
	s, err := New(Config{BuildID: "build", ProfileID: "test", Generation: "generation", Methods: map[string]Method{
		"chat.browser.next": {Handle: func(context.Context, Request) (*Outcome, error) {
			return &Outcome{Status: "ok", Data: json.RawMessage(`{"command":null}`)}, nil
		}},
		"computer.settings.store.next": {Handle: func(context.Context, Request) (*Outcome, error) {
			return &Outcome{Status: "ok", Data: json.RawMessage(`{"command":null}`)}, nil
		}},
		"computer.connector.health": {Handle: func(_ context.Context, request Request) (*Outcome, error) {
			var original wire.ComputerConnectorHealthRequest
			if err := json.Unmarshal(request.Body, &original); err != nil {
				return nil, err
			}
			state := wire.ComputerConnectorHealthState{Binding: original.Binding, ExpectedInstanceId: original.ExpectedInstanceId, State: "unobserved", Reason: "missing_snapshot"}
			if original.Snapshot != nil {
				state.SampleAtMillis = &original.Snapshot.SnapshotAtMillis
			}
			data, err := json.Marshal(state)
			return &Outcome{Status: "ok", Data: data}, err
		}},
		"core.retirement.prepare": {Handle: func(context.Context, Request) (*Outcome, error) {
			return &Outcome{Status: "ok", Data: json.RawMessage(`{}`)}, nil
		}},
		"core.retirement.ack": {Handle: func(context.Context, Request) (*Outcome, error) {
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

func TestHealthReadLifetimeRetainsBoundedHistoryAndRetirement(t *testing.T) {
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
	const reads = 6001
	for i := 1; i <= reads; i++ {
		body := idleHealthBody
		if i%2 == 0 {
			body = idleHealthBody[:len(idleHealthBody)-1] + `,"snapshot":{"snapshotAtMillis":"9007199254740993","runtimeInstanceId":"instance","runtimeStartedAtMillis":"1","runtimeLifecycle":"running","runtimeLimited":false,"live":true,"ready":true,"truncated":false}}`
		}
		appendFrame(request(fmt.Sprintf("desktop-poll-health:%s:%d", idleNonce, i), "computer.connector.health", body, &ctx))
	}
	for _, method := range []string{"core.retirement.prepare", "core.retirement.ack"} {
		var original wire.Request
		if err := json.Unmarshal(request(method, method, `{}`, &ctx), &original); err != nil {
			t.Fatal(err)
		}
		original.Params.OperationId = optional("original-" + method)
		raw, err := json.Marshal(original)
		if err != nil {
			t.Fatal(err)
		}
		appendFrame(raw)
		appendFrame(raw)
	}
	appendFrame(request("status", "core.status", `{}`, &ctx))
	out := &bufferWriter{}
	if err := s.Serve(context.Background(), io.NopCloser(&frames), out); err != nil {
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
		switch count {
		case reads + 3, reads + 5:
			if response.Error == nil || response.Error.Message != "duplicate request ID" {
				t.Fatalf("effect/control replay admitted: %+v", response)
			}
		default:
			if response.Result == nil || response.Result.Status != "ok" {
				t.Fatalf("response %d: %+v", count, response)
			}
			if count > 1 && count <= reads+1 && wire.Validate("ComputerConnectorHealthState", response.Result.Data) != nil {
				t.Fatalf("invalid framed health response %d", count)
			}
			if count > 1 && count <= reads+1 {
				var state wire.ComputerConnectorHealthState
				if err := json.Unmarshal(response.Result.Data, &state); err != nil {
					t.Fatal(err)
				}
				if (count-1)%2 == 0 {
					if state.SampleAtMillis == nil || *state.SampleAtMillis != "9007199254740993" {
						t.Fatal("lost the original health sample echo")
					}
				} else if state.SampleAtMillis != nil {
					t.Fatal("invented a sample for an absent snapshot")
				}
			}
		}
	}
	if count != reads+6 || len(s.seen) != 4 || len(s.polls) != 1 || s.polls["health"] != reads {
		t.Fatalf("unbounded/lost health history: responses=%d ordinary=%d polls=%v", count, len(s.seen), s.polls)
	}
}

func TestOrderedHealthReadRequiresExactLaneAndOriginalContext(t *testing.T) {
	for _, name := range []string{
		"duplicate", "skipped", "zero", "leading-zero", "overflow", "max-not-next", "nonce", "bad-nonce", "unknown-lane",
		"browser-method", "settings-method", "browser-lane", "settings-lane", "status-method", "effect-method", "polling-method",
		"empty", "extra", "missing-instance", "invalid-snapshot", "duplicate-field", "profile", "generation", "no-context", "operation",
	} {
		t.Run(name, func(t *testing.T) {
			s := idleServer(t)
			handshake(s)
			ctx := s.context()
			id := "desktop-poll-health:" + idleNonce + ":"
			if response := s.dispatch(context.Background(), request(id+"1", "computer.connector.health", idleHealthBody, &ctx)); response.Result == nil || !s.pollAdmitted {
				t.Fatal("first health read refused")
			}
			var invalid wire.Request
			if err := json.Unmarshal(request(id+"2", "computer.connector.health", idleHealthBody, &ctx), &invalid); err != nil {
				t.Fatal(err)
			}
			switch name {
			case "duplicate":
				invalid.Id = id + "1"
			case "skipped":
				invalid.Id = id + "3"
			case "zero":
				invalid.Id = id + "0"
			case "leading-zero":
				invalid.Id = id + "02"
			case "overflow":
				invalid.Id = id + "18446744073709551616"
			case "max-not-next":
				invalid.Id = id + "18446744073709551615"
			case "nonce":
				invalid.Id = "desktop-poll-health:a0000000-0000-4000-8000-000000000002:2"
			case "bad-nonce":
				invalid.Id = "desktop-poll-health:invalid:2"
			case "unknown-lane":
				invalid.Id = "desktop-poll-health-other:" + idleNonce + ":2"
			case "browser-method":
				invalid.Method = "chat.browser.next"
			case "settings-method":
				invalid.Method = "computer.settings.store.next"
			case "browser-lane":
				invalid.Id = "desktop-poll-browser:" + idleNonce + ":1"
			case "settings-lane":
				invalid.Id = "desktop-poll-settings:" + idleNonce + ":1"
			case "status-method":
				invalid.Method = "core.status"
			case "effect-method":
				invalid.Method = "core.retirement.prepare"
				invalid.Params.OperationId = optional("effect")
			case "polling-method":
				invalid.Method = "computer.connector.polling"
			case "empty":
				invalid.Params.Body = json.RawMessage(`{}`)
			case "extra":
				invalid.Params.Body = json.RawMessage(idleHealthBody[:len(idleHealthBody)-1] + `,"extra":true}`)
			case "missing-instance":
				invalid.Params.Body = bytes.ReplaceAll(invalid.Params.Body, []byte(`,"expectedInstanceId":"instance"`), nil)
			case "invalid-snapshot":
				invalid.Params.Body = json.RawMessage(idleHealthBody[:len(idleHealthBody)-1] + `,"snapshot":{}}`)
			case "duplicate-field":
				invalid.Params.Body = json.RawMessage(idleHealthBody[:len(idleHealthBody)-1] + `,"expectedInstanceId":"instance"}`)
			case "profile":
				invalid.Params.Context.ProfileId = "other"
			case "generation":
				invalid.Params.Context.BackendGeneration = "stale"
			case "no-context":
				invalid.Params.Context = nil
			case "operation":
				invalid.Params.OperationId = optional("not-read-only")
			}
			raw, err := json.Marshal(invalid)
			if err != nil {
				t.Fatal(err)
			}
			if response := s.dispatch(context.Background(), raw); response.Error == nil || s.pollAdmitted {
				t.Fatalf("invalid health read admitted: %+v", response)
			}
			if response := s.dispatch(context.Background(), request(id+"2", "computer.connector.health", idleHealthBody, &ctx)); response.Result == nil || !s.pollAdmitted {
				t.Fatal("invalid attempt consumed the original sequence")
			}
		})
	}
}

func TestOrderedHealthReadRequiresHandshakeAndRegisteredHandler(t *testing.T) {
	for _, connected := range []bool{false, true} {
		s := idleServer(t)
		if connected {
			delete(s.config.Methods, "computer.connector.health")
			handshake(s)
		}
		ctx := s.context()
		raw := request("desktop-poll-health:"+idleNonce+":1", "computer.connector.health", idleHealthBody, &ctx)
		if response := s.dispatch(context.Background(), raw); response.Error == nil || s.pollAdmitted || len(s.polls) != 0 || s.pollNonce != "" {
			t.Fatal("health lane admitted without handshake or handler")
		}
	}
}

func TestOrderedHealthReadSequenceCannotWrap(t *testing.T) {
	s := idleServer(t)
	handshake(s)
	ctx := s.context()
	s.pollNonce = idleNonce
	s.polls["health"] = ^uint64(0) - 1
	id := "desktop-poll-health:" + idleNonce + ":"
	if response := s.dispatch(context.Background(), request(id+"18446744073709551615", "computer.connector.health", idleHealthBody, &ctx)); response.Result == nil || !s.pollAdmitted {
		t.Fatal("last uint64 sequence refused")
	}
	for _, sequence := range []string{"18446744073709551615", "18446744073709551616", "0", "1"} {
		if response := s.dispatch(context.Background(), request(id+sequence, "computer.connector.health", idleHealthBody, &ctx)); response.Error == nil || s.pollAdmitted {
			t.Fatalf("wrapped/replayed sequence admitted: %s", sequence)
		}
	}
}

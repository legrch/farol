package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

func TestControlledFixtureUsesRealGoWireAndClassifiesLostSend(t *testing.T) {
	for _, scenario := range []string{"text", "lost-send-reply"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			server, stats, err := compose(ctx, scenario)
			if err != nil {
				t.Fatal(err)
			}
			input, send := io.Pipe()
			receive, output := io.Pipe()
			done := make(chan error, 1)
			go func() { done <- server.Serve(ctx, input, output) }()
			t.Cleanup(func() {
				send.Close()
				receive.Close()
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Error("fixture server cleanup unconfirmed")
				}
			})
			sequence := 0
			call := func(method string, body any, effect bool) wire.Response {
				t.Helper()
				sequence++
				id := "request-" + strconv.Itoa(sequence)
				raw, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				req := wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: wire.Call{Body: raw}}
				if method != "core.handshake" {
					req.Params.Context = &wire.Context{ProfileId: "profile", BackendGeneration: "backend"}
				}
				if effect {
					op := "operation-" + strconv.Itoa(sequence)
					req.Params.OperationId = &op
				}
				raw, err = json.Marshal(req)
				if err != nil {
					t.Fatal(err)
				}
				if err = ipc.WriteFrame(send, raw); err != nil {
					t.Fatal(err)
				}
				raw, err = ipc.ReadFrame(receive)
				if err != nil {
					t.Fatal(err)
				}
				var response wire.Response
				if json.Unmarshal(raw, &response) != nil {
					t.Fatal("invalid actual wire")
				}
				return response
			}
			ok := func(r wire.Response) json.RawMessage {
				t.Helper()
				if r.Result == nil || r.Result.Status != "ok" {
					t.Fatal("nonpositive actual Go reply", r)
				}
				return r.Result.Data
			}
			ok(call("core.handshake", wire.Handshake{ProtocolMajor: 1, ProtocolMinor: 0, BuildId: fixtureBuild, ProfileId: "profile"}, false))
			selection := wire.BrowserSelection{Provider: "farol", Alias: "chatgpt", AccountId: "controlled-account", ModelId: "controlled-model", Effort: "low", Mode: "standard"}
			request := wire.ChatCreate{SessionId: "session", Prompt: "Controlled fixture question", Selection: selection, Resolution: wire.BrowserResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", RequestedMode: "standard", ConfigSHA256: strings.Repeat("a", 64), TranslationId: "configured", Resolved: selection}, Required: wire.BrowserRequiredControls{Model: true, Effort: true, Mode: true}}
			var handle wire.ChatHandle
			if json.Unmarshal(ok(call("chat.conversation.create", request, true)), &handle) != nil {
				t.Fatal("handle")
			}
			deadline := strconv.FormatInt(time.Now().Add(10*time.Second).UnixMilli(), 10)
			ok(call("chat.conversation.prepare", wire.ChatDeadline{DeadlineMillis: deadline}, true))
			sent := call("chat.conversation.send", wire.ChatAction{HandleId: handle.HandleId, DeadlineMillis: deadline}, true)
			if scenario == "lost-send-reply" {
				// The command handled the unknown result successfully; Empty is not
				// provider acceptance. Go emits a failure frame and retains unknown.
				ok(sent)
				var failed wire.ChatFrames
				if json.Unmarshal(ok(call("chat.conversation.events", wire.ChatEventsRequest{HandleId: handle.HandleId, AfterSequence: "0"}, false)), &failed) != nil {
					t.Fatal("failure frames")
				}
				found := false
				for _, frame := range failed.Frames {
					found = found || frame.Kind == "response.failed"
					if frame.Kind == "response.completed" {
						t.Fatal("unknown became successful completion")
					}
				}
				if !found {
					t.Fatal("unknown lacks actual Go failure event")
				}
				var snapshot wire.ChatSubmissionState
				if json.Unmarshal(ok(call("chat.conversation.submission", wire.ChatHandleRequest{HandleId: handle.HandleId}, false)), &snapshot) != nil || snapshot.State != "unknown" {
					t.Fatal("lost send became known", snapshot)
				}
			} else {
				ok(sent)
				for range 2 {
					ok(call("chat.conversation.observe", wire.ChatAction{HandleId: handle.HandleId, DeadlineMillis: deadline}, true))
				}
				var frames wire.ChatFrames
				if json.Unmarshal(ok(call("chat.conversation.events", wire.ChatEventsRequest{HandleId: handle.HandleId, AfterSequence: "0"}, false)), &frames) != nil {
					t.Fatal("frames")
				}
				useful := false
				for _, frame := range frames.Frames {
					if frame.Kind == "response.completed" {
						t.Fatal("no useful prefix before terminal")
					}
					useful = useful || (frame.Kind == "response.output_text.delta" && strings.Contains(string(frame.Data), "Useful before tool."))
				}
				if !useful {
					t.Fatal("missing actual Go streaming prefix")
				}
			}
			r := stats.snapshot()
			if r.PhysicalSendAttempts != 1 || r.AcceptedSubmissions != 1 || r.Methods["chat.conversation.create"].Known != 1 || r.Commits["dispatch"] != 1 {
				t.Fatal("wrong controlled effects", r)
			}
		})
	}
}
func TestControlledFixtureRejectsUnknownScenario(t *testing.T) {
	if server, _, err := compose(context.Background(), "live"); err == nil || server != nil {
		t.Fatal("unknown scenario admitted")
	}
}

// Exercise the same run entry used by the separately compiled CPU peer. READY
// must be observable before any input, while real protocol admission stays shut.
func TestControlledReadinessDoesNotGrantProtocolAdmission(t *testing.T) {
	input, send := io.Pipe()
	receive, output := io.Pipe()
	diagnostics, diagnostic := io.Pipe()
	finished := make(chan struct{})
	exitCode := -1
	go func() {
		exitCode = run([]string{"reciprocal"}, input, output, diagnostic)
		diagnostic.Close()
		close(finished)
	}()
	closePipes := func() {
		send.Close()
		receive.Close()
		diagnostics.Close()
	}
	watchdog := time.AfterFunc(5*time.Second, closePipes)
	t.Cleanup(func() {
		watchdog.Stop()
		closePipes()
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("original fixture run cleanup unconfirmed")
		}
	})
	reader := bufio.NewReader(diagnostics)
	ready, err := reader.ReadString('\n')
	if err != nil || ready != fixtureReady+"\n" {
		t.Fatal("fixture did not declare readiness before input", ready, err)
	}
	sequence := 0
	call := func(method string, body any) wire.Response {
		t.Helper()
		sequence++
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := wire.Request{Jsonrpc: "2.0", Id: "request-" + strconv.Itoa(sequence), Method: method, Params: wire.Call{Body: raw}}
		if method != "core.handshake" {
			request.Params.Context = &wire.Context{ProfileId: "profile", BackendGeneration: "backend"}
		}
		raw, err = json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		if err = ipc.WriteFrame(send, raw); err != nil {
			t.Fatal(err)
		}
		raw, err = ipc.ReadFrame(receive)
		if err != nil {
			t.Fatal(err)
		}
		var reply wire.Response
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	before := call("core.status", wire.Empty{})
	if before.Error == nil || before.Error.Code != -32001 || before.Result != nil {
		t.Fatal("readiness admitted an unauthenticated request", before)
	}
	handshake := call("core.handshake", wire.Handshake{ProtocolMajor: 1, ProtocolMinor: 0, BuildId: fixtureBuild, ProfileId: "profile"})
	if handshake.Result == nil || handshake.Result.Status != "ok" {
		t.Fatal("real handshake failed", handshake)
	}
	after := call("core.status", wire.Empty{})
	if after.Result == nil || after.Result.Status != "ok" {
		t.Fatal("handshake did not admit status", after)
	}
	if err := send.Close(); err != nil {
		t.Fatal(err)
	}
	line, err := reader.ReadString('\n')
	const prefix = "FAROL_CHAT_RESPONSES_CPU "
	if err != nil || !strings.HasPrefix(line, prefix) {
		t.Fatal("original EOF receipt missing", line, err)
	}
	var evidence receipt
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, prefix)), &evidence); err != nil {
		t.Fatal(err)
	}
	if !evidence.ServerEOF || evidence.Scenario != "reciprocal" || evidence.PhysicalSendAttempts != 0 || evidence.AcceptedSubmissions != 0 || len(evidence.Methods) != 0 {
		t.Fatal("unexpected effects or missing original EOF", evidence)
	}
	select {
	case <-finished:
		if exitCode != 0 {
			t.Fatal("original run did not exit cleanly", exitCode)
		}
	case <-time.After(time.Second):
		t.Fatal("original run terminal unobserved")
	}
}

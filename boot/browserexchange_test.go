package boot

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
)

func exchangeFixture(t *testing.T) (*BrowserExchange, context.CancelFunc, browser.SendCommand) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	b, err := NewBrowserExchange(ctx, wire.Context{ProfileId: "profile", BackendGeneration: "backend"})
	if err != nil {
		t.Fatal(err)
	}
	binding := browser.Binding{ProviderState: "bound", Lease: browser.Lease{Identity: browser.Identity{ProfileID: "profile", OwnerID: "owner", SessionID: "session", TaskID: "task", TurnID: "turn", OperationID: "operation", TurnGeneration: 9007199254740993}, BackendGeneration: "backend", SlotOrdinal: 4, SlotGeneration: 9007199254740995}, ViewID: "view", ViewGeneration: 2, DocumentGeneration: 3, ConversationID: "conversation"}
	command := browser.SendCommand{Binding: binding, Verification: browser.Verification{Binding: binding, Pinned: browser.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "high", Mode: "instant", ConnectorID: "connector", ConnectorGrantID: "grant"}, Required: browser.RequiredControls{Model: true}, Observed: browser.SelectionFacts{Model: browser.ControlFact{Source: "public-control", Value: "model", Literal: "model"}, Effort: browser.ControlFact{Source: "unknown"}, Mode: browser.ControlFact{Source: "unknown"}, Connector: browser.ControlFact{Source: "unknown"}, ObservedAtMillis: 1}, IntentDigest: strings.Repeat("a", 64), EvidenceID: "evidence"}, IntentDigest: strings.Repeat("a", 64), Prompt: "Useful text 🪔", DeadlineMillis: uint64(time.Now().Add(10 * time.Second).UnixMilli())}
	return b, cancel, command
}
func beginBrowserCall(b *BrowserExchange, ctx context.Context, c browser.Command) <-chan browserReplyResult {
	done := make(chan browserReplyResult, 1)
	go func() { v, err := b.Exchange(ctx, c); done <- browserReplyResult{reply: v, err: err} }()
	return done
}
func awaitBrowserCall(t *testing.T, done <-chan browserReplyResult) browserReplyResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(time.Second):
		t.Fatal("browser exchange retained completed call")
		return browserReplyResult{}
	}
}
func nextBrowserCall(t *testing.T, b *BrowserExchange) *wire.BrowserCommand {
	t.Helper()
	call, err := b.next(context.Background(), uint64(time.Now().Add(time.Second).UnixMilli()))
	if err != nil || call == nil {
		t.Fatalf("missing command: %v", err)
	}
	return call
}
func TestBrowserExchangeRoundTripBindsExactCallWithoutSecondDispatch(t *testing.T) {
	b, _, command := exchangeFixture(t)
	done := beginBrowserCall(b, context.Background(), command)
	call := nextBrowserCall(t, b)
	if call.Kind != "send" || wire.Validate("BrowserSend", call.Body) != nil {
		t.Fatal("wrong canonical command")
	}
	var send wire.BrowserSend
	if json.Unmarshal(call.Body, &send) != nil || send.Prompt != command.Prompt || send.Binding.Lease.SlotGeneration != "9007199254740995" {
		t.Fatal("lossy mapping")
	}
	raw, _ := json.Marshal(wire.BrowserSent{Binding: send.Binding, VerificationId: send.Verification.EvidenceId, Status: "submitted", Code: ""})
	reply := wire.BrowserReply{CommandId: call.CommandId, Kind: "send", Body: raw}
	if err := b.complete(reply); err != nil {
		t.Fatal(err)
	}
	result := awaitBrowserCall(t, done)
	if result.err != nil {
		t.Fatal(result.err)
	}
	sent, ok := result.reply.(browser.SentReply)
	if !ok || sent.Binding != command.Binding || sent.VerificationID != "evidence" {
		t.Fatal("reply lost identity")
	}
	if b.complete(reply) == nil {
		t.Fatal("duplicate completion accepted")
	}
	if len(b.ready) != 0 {
		t.Fatal("command redispatched")
	}
}
func TestBrowserExchangeConsumesMalformedReplyWithoutCorrection(t *testing.T) {
	for _, kind := range []string{"crossed-kind", "invalid-body"} {
		t.Run(kind, func(t *testing.T) {
			b, _, command := exchangeFixture(t)
			done := beginBrowserCall(b, context.Background(), command)
			call := nextBrowserCall(t, b)
			reply := wire.BrowserReply{CommandId: call.CommandId, Kind: "send", Body: json.RawMessage(`{}`)}
			if kind == "crossed-kind" {
				reply.Kind = "observe"
			}
			if b.complete(reply) == nil {
				t.Fatal("invalid reply accepted")
			}
			if awaitBrowserCall(t, done).err == nil {
				t.Fatal("invalid reply became known success")
			}
			if b.complete(reply) == nil || len(b.ready) != 0 {
				t.Fatal("invalid completion retried")
			}
		})
	}
}
func TestBrowserExchangeCancellationAfterDeliveryDoesNotRequeue(t *testing.T) {
	b, _, command := exchangeFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := beginBrowserCall(b, ctx, command)
	call := nextBrowserCall(t, b)
	cancel()
	if awaitBrowserCall(t, done).err == nil {
		t.Fatal("cancelled delivery reported known")
	}
	if b.complete(wire.BrowserReply{CommandId: call.CommandId, Kind: "send", Body: json.RawMessage(`{}`)}) == nil {
		t.Fatal("late reply admitted")
	}
	if len(b.ready) != 0 {
		t.Fatal("unknown send requeued")
	}
}
func TestBrowserExchangeRefusesStaleScopeAndDeadlineBeforeEnqueue(t *testing.T) {
	b, _, command := exchangeFixture(t)
	command.Binding.Lease.BackendGeneration = "other"
	if _, err := b.Exchange(context.Background(), command); err == nil {
		t.Fatal("crossed scope")
	}
	command.Binding.Lease.BackendGeneration = "backend"
	command.DeadlineMillis = 1
	if _, err := b.Exchange(context.Background(), command); err == nil {
		t.Fatal("expired command")
	}
	if b.issued != 0 || len(b.ready) != 0 {
		t.Fatal("refused input became pending work")
	}
}
func TestBrowserExchangeRootClosureSettlesAllWaiters(t *testing.T) {
	b, cancel, command := exchangeFixture(t)
	done := beginBrowserCall(b, context.Background(), command)
	nextBrowserCall(t, b)
	cancel()
	if awaitBrowserCall(t, done).err == nil {
		t.Fatal("closed root reported known provider result")
	}
}

func TestBrowserExchangeQuiescenceWakesIdlePollWithoutClosingTransport(t *testing.T) {
	b, _, command := exchangeFixture(t)
	done := make(chan error, 1)
	go func() {
		value, err := b.next(context.Background(), uint64(time.Now().Add(14*time.Second).UnixMilli()))
		if value != nil {
			done <- context.Canceled
			return
		}
		done <- err
	}()
	if err := b.QuiescePolling(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("idle poll must finish normally: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle poll did not wake for retirement ACK")
	}
	if b.ctx.Err() != nil {
		t.Fatal("transport lifetime was closed")
	}
	if err := b.QuiescePolling(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Exchange(context.Background(), command); err == nil {
		t.Fatal("quiesced exchange admitted new effect")
	}
	if b.issued != 0 || len(b.ready) != 0 {
		t.Fatal("shutdown command escaped")
	}
}

func TestBrowserExchangeQuiescenceRefusesOutstandingEffect(t *testing.T) {
	b, _, command := exchangeFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := beginBrowserCall(b, ctx, command)
	nextBrowserCall(t, b)
	if b.QuiescePolling() == nil {
		t.Fatal("pending effect reported quiescent")
	}
	select {
	case <-b.pollStopped:
		t.Fatal("refused quiescence stopped cleanup delivery")
	default:
	}
	cancel()
	if awaitBrowserCall(t, done).err == nil {
		t.Fatal("cancel became known provider result")
	}
	if err := b.QuiescePolling(); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserExchangeClosedLifetimeCannotProveQuiescence(t *testing.T) {
	b, cancel, _ := exchangeFixture(t)
	cancel()
	if b.QuiescePolling() == nil {
		t.Fatal("closed lifetime became quiescence")
	}
}

// Exercises both mailbox directions using the shared external snapshot bytes.
// No pipe, browser, provider or admission is involved at this pure layer.
func TestBrowserExchangeAccountSnapshotRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("../api/desktop/v1/fixtures/browser-account-observation.json")
	if err != nil {
		t.Fatal(err)
	}
	var account wire.BrowserAccountObservation
	if err := json.Unmarshal(raw, &account); err != nil {
		t.Fatal(err)
	}
	for _, present := range []bool{true, false} {
		t.Run(map[bool]string{true: "observed", false: "unqualified"}[present], func(t *testing.T) {
			b, _, command := exchangeFixture(t)
			verify := browser.VerifySendCommand{Binding: command.Binding, Requested: command.Verification.Pinned, Required: command.Verification.Required, IntentDigest: command.IntentDigest, DeadlineMillis: command.DeadlineMillis}
			done := beginBrowserCall(b, context.Background(), verify)
			call := nextBrowserCall(t, b)
			if call.Kind != "verify-send" {
				t.Fatal("wrong command")
			}
			proof := toBrowserVerification(command.Verification)
			if present {
				copy := account
				proof.Account = &copy
			}
			encoded, err := json.Marshal(wire.BrowserVerified{Verification: proof})
			if err != nil {
				t.Fatal(err)
			}
			if err := b.complete(wire.BrowserReply{CommandId: call.CommandId, Kind: call.Kind, Body: encoded}); err != nil {
				t.Fatal(err)
			}
			result := awaitBrowserCall(t, done)
			if result.err != nil {
				t.Fatal(result.err)
			}
			returned, ok := result.reply.(browser.VerifiedReply)
			if !ok {
				t.Fatal("wrong reply")
			}
			want := browser.AccountObservation{}
			if present {
				want = browser.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("c", 64), ObservedAtMillis: 1000, ExpiresAtMillis: 60000}
			}
			if returned.Verification.Account != want {
				t.Fatal("inbound account lost or fabricated from pinned account")
			}
			command.Verification = returned.Verification
			done = beginBrowserCall(b, context.Background(), command)
			call = nextBrowserCall(t, b)
			var sent wire.BrowserSend
			if err := json.Unmarshal(call.Body, &sent); err != nil {
				t.Fatal(err)
			}
			if present {
				if sent.Verification.Account == nil || *sent.Verification.Account != account {
					t.Fatal("outbound account changed")
				}
			} else if sent.Verification.Account != nil {
				t.Fatal("omitted account fabricated")
			}
			encoded, err = json.Marshal(wire.BrowserSent{Binding: sent.Binding, VerificationId: sent.Verification.EvidenceId, Status: "submitted", Code: ""})
			if err != nil {
				t.Fatal(err)
			}
			if err := b.complete(wire.BrowserReply{CommandId: call.CommandId, Kind: call.Kind, Body: encoded}); err != nil {
				t.Fatal(err)
			}
			if result := awaitBrowserCall(t, done); result.err != nil {
				t.Fatal(result.err)
			}
		})
	}
}

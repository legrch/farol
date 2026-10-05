//go:build darwin

package boot

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/app/port"
)

// This peer answers the actual normal-runtime browser exchange. Only browser
// observations and host terminal/drain are fixtures; stores, lifecycle owners,
// retirement, and successor boot are real. No app, child process or provider runs.
type retainedNativePeer struct {
	t       *testing.T
	runtime *NativeRuntime
	sends   int
}

func (p *retainedNativePeer) run(action func(uint64) error, kinds ...string) {
	p.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	deadline := uint64(time.Now().Add(3 * time.Second).UnixMilli())
	done := make(chan error, 1)
	go func() { done <- action(deadline) }()
	for _, kind := range kinds {
		c, err := p.runtime.browser.next(ctx, deadline)
		if err != nil || c == nil {
			p.t.Fatal("missing browser command", err)
		}
		commandKind := kind
		if kind == "accepted" || kind == "answer-delta" || kind == "completed" || kind == "quiescent" {
			commandKind = "observe"
		}
		if c.Kind != commandKind {
			p.t.Fatalf("expected %s, got %s", commandKind, c.Kind)
		}
		var reply any
		switch c.Kind {
		case "prepare":
			r := decodeChat[wire.BrowserPrepare](p.t, c.Body)
			state, cid := "home", ""
			if r.Target.Mode == "owned-saved" {
				state, cid = "bound", "controlled-provider-conversation"
				if r.Target.ConversationId != cid {
					p.t.Fatal("follow changed conversation")
				}
			}
			reply = wire.BrowserPrepared{Saved: state == "bound", Readiness: "ready", Binding: wire.BrowserBinding{ProviderState: state, Lease: r.Lease, ViewId: "controlled-view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationId: cid}}
		case "verify-send":
			r := decodeChat[wire.BrowserVerifySend](p.t, c.Body)
			reply = wire.BrowserVerified{Verification: wire.BrowserVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: controlledWireFacts(r.Requested), PreviousUserTurnId: r.PreviousUserTurnId, PreviousReplyId: r.PreviousReplyId, IntentDigest: r.IntentDigest, EvidenceId: "proof-" + r.Binding.Lease.Identity.OperationId}}
		case "send":
			r := decodeChat[wire.BrowserSend](p.t, c.Body)
			p.sends++
			reply = wire.BrowserSent{Binding: r.Binding, VerificationId: r.Verification.EvidenceId, Status: "submitted"}
		case "observe":
			r := decodeChat[wire.BrowserObserve](p.t, c.Body)
			e := wire.BrowserObservation{Binding: r.Binding, Sequence: decimal(wireUint(r.AfterSequence) + 1), ObservedAtMillis: decimal(uint64(time.Now().UnixMilli())), Kind: kind, UserTurnId: "user-" + r.Binding.Lease.Identity.TurnId, ReplyId: "reply-" + r.Binding.Lease.Identity.TurnId}
			if kind == "accepted" && r.Binding.ProviderState == "home" {
				e.ProviderConversationId = "controlled-provider-conversation"
			}
			if kind == "answer-delta" {
				e.Text, e.SegmentId = "Retained answer for "+r.Binding.Lease.Identity.TurnId+" ☀", "segment-1"
			}
			reply = wire.BrowserObserved{Events: []wire.BrowserObservation{e}}
		}
		body, err := json.Marshal(reply)
		if err != nil {
			p.t.Fatal(err)
		}
		if err := p.runtime.browser.complete(wire.BrowserReply{CommandId: c.CommandId, Kind: c.Kind, Body: body}); err != nil {
			p.t.Fatal(err)
		}
	}
	select {
	case err := <-done:
		if err != nil {
			p.t.Fatal(err)
		}
	case <-ctx.Done():
		p.t.Fatal("browser action outcome unknown; no replay")
	}
}

func retainedNativeRetire(t *testing.T, launch NativeLaunch, runtime *NativeRuntime) []port.ResultRead {
	t.Helper()
	prepared := retirementCall(t, runtime, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "handoff-" + runtime.retirement.binding.BackendGeneration})
	if prepared.Status != "ok" {
		t.Fatalf("retirement prepare: %+v", prepared)
	}
	if runtime.history == nil {
		t.Fatal("normal boot omitted current history reader")
	}
	if page, err := runtime.history.List(context.Background(), 0); err == nil || page != nil {
		t.Fatal("retirement left historical read authority active")
	}
	p := decodeChat[wire.CoreRetirementPrepared](t, prepared.Data)
	head, err := runtime.retirement.repo.Load(context.Background())
	if err != nil || head == nil || head.Record == nil {
		t.Fatal("missing original retirement", err)
	}
	var reads []port.ResultRead
	for _, v := range head.Record.Receipt.Write.Turns {
		reads = append(reads, port.ResultRead{Binding: v.Binding, Result: v.Snapshot.Result, Publication: v.ResultPublication})
	}
	ack := retirementCall(t, runtime, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: p.HandoffId, ReceiptDigest: p.ReceiptDigest})
	if ack.Status != "ok" {
		t.Fatalf("retirement ACK: %+v", ack)
	}
	a := decodeChat[wire.CoreRetirementAcknowledged](t, ack.Data)
	binding := runtime.retirement.binding
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	// Exact exit and drain are explicit fixtures, not inferred from Close.
	o := wire.CoreTerminalObservation{HandoffId: a.HandoffId, ReceiptDigest: a.ReceiptDigest, AckDigest: a.AckDigest, BackendGeneration: binding.BackendGeneration, HostLifetimeId: binding.HostLifetimeID, ChildLaunchId: binding.ChildLaunchID, ExitCode: "0"}
	if err := recordNativeTerminal(context.Background(), launch.Profile, o, func(wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	return reads
}

func TestNativeRetainedTwoTurnResultsSurviveCleanSuccessorsWithoutSend(t *testing.T) {
	launch, runtime := retirementFixture(t)
	if _, ok := any(runtime.results).(port.DurableResults); !ok {
		t.Fatal("normal Go startup still uses memory-only results")
	}
	ctx := context.Background()
	if page, err := runtime.history.List(ctx, 0); err != nil || page == nil || page.Total != 0 || page.Entries == nil {
		t.Fatal("fresh profile lacks authorized empty history", err)
	}
	p := &retainedNativePeer{t: t, runtime: runtime}
	i := port.ConversationInput{Binding: port.TurnBinding{ProfileID: launch.Profile.ProfileID, BackendGeneration: "generation-1", OwnerID: launch.OwnerID, SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", OperationID: "operation-1", TurnID: "turn-1", TurnGeneration: 1}, Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "controlled-account", ModelID: "controlled-model", Effort: "low"}, Required: port.RequiredControls{Model: true}, Prompt: "Synthetic durable result test"}
	c, err := runtime.chat.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	want := make(map[string]port.ConversationResult)
	for n := 0; n < 2; n++ {
		p.run(func(d uint64) error { _, err := runtime.chat.PrepareNext(ctx, d); return err }, "prepare")
		p.run(func(d uint64) error { return c.Send(ctx, d) }, "verify-send", "send")
		for _, kind := range []string{"accepted", "answer-delta", "completed"} {
			p.run(func(d uint64) error { return c.Observe(ctx, d) }, kind)
		}
		r, err := c.Result(ctx)
		if err != nil || !r.Complete {
			t.Fatal("missing terminal result", err)
		}
		want[r.Binding.OperationID] = *r
		if err := c.Acknowledge(ctx, r.ResultID); err != nil {
			t.Fatal(err)
		}
		p.run(func(d uint64) error { return c.Observe(ctx, d) }, "quiescent")
		if n == 0 {
			i.Binding.OperationID, i.Binding.TurnID, i.Binding.TurnGeneration = "operation-2", "turn-2", 2
			c, err = runtime.chat.FollowConversation(ctx, c, i)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	reads := retainedNativeRetire(t, launch, runtime)
	if len(reads) != 2 || p.sends != 2 {
		t.Fatal("retirement lost a turn or repeated a Send")
	}
	for cycle := 2; cycle <= 3; cycle++ {
		launch.StoreMode, launch.PreviousHostDrainConfirmed = "open", true // Explicit host fixture.
		launch.HostLifetimeID, launch.ChildLaunchID = fmt.Sprint("host-", cycle), fmt.Sprint("child-", cycle)
		next, err := NewNativeRuntime(ctx, launch, fmt.Sprint("generation-", cycle))
		if err != nil {
			t.Fatal("known clean successor refused", err)
		}
		t.Cleanup(func() {
			if err := next.Close(); err != nil {
				t.Error(err)
			}
		})
		// Discover references from the actual qualified ancestor chain. Test-held
		// original values are only an independent oracle, never read authority.
		page, err := next.history.List(ctx, 0)
		if err != nil || page == nil || page.Total != 2 || len(page.Entries) != 2 {
			t.Fatal("ancestor discovery failed", err)
		}
		for _, summary := range page.Entries {
			got, err := next.history.Read(ctx, summary.Key)
			w, found := want[summary.Key.OperationID]
			if !found || err != nil || got == nil || got.Binding != w.Binding || got.Text != w.Text || got.ResultID != w.ResultID || got.ProviderConversationID != w.ProviderConversationID || got.ProviderUserTurnID != w.ProviderUserTurnID || got.ProviderReplyID != w.ProviderReplyID || got.Requested != w.Requested || got.Observed != w.Observed || got.Evidence != w.Evidence || !got.Complete || !got.Acknowledged || got.Phase != "delivered" || summary.Binding != w.Binding || summary.ResultID != w.ResultID || summary.ProviderConversationID != w.ProviderConversationID {
				t.Fatal("authorized history lost original result", err)
			}
		}
		if len(next.conversations.handles) != 0 || len(next.conversations.used) != 0 {
			t.Fatal("historical read reconstructed live handles")
		}
		store := any(next.results).(port.DurableResults)
		for _, read := range reads {
			got, err := store.Read(ctx, read)
			w := want[read.Binding.OperationID]
			if err != nil || got == nil || got.Binding != w.Binding || string(got.Payload) != w.Text || got.Result.ID != w.ResultID || got.Conversation.ProviderConversationID != w.ProviderConversationID || got.Conversation.ProviderUserTurnID != w.ProviderUserTurnID || got.Conversation.ProviderReplyID != w.ProviderReplyID || got.Conversation.Requested != w.Requested || got.Conversation.Observed != w.Observed || got.Conversation.Evidence != w.Evidence || !got.Conversation.Complete {
				t.Fatal("historical storage read lost exact result", err)
			}
		}
		if next.browser.issued != 0 || p.sends != 2 {
			t.Fatal("storage read launched provider work")
		}
		// A further empty retirement must not erase the original stored bytes.
		if cycle == 2 {
			if retained := retainedNativeRetire(t, launch, next); len(retained) != 0 {
				t.Fatal("old live handles were restored")
			}
		} else {
			next.historyAuthority.close()
			if v, err := next.history.Read(ctx, page.Entries[0].Key); err == nil || v != nil {
				t.Fatal("closed authority disclosed retained content")
			}
		}
	}
	t.Log("Two controlled Sends, two retained results, actual ancestor discovery/current-authorized read across two successor boots, zero successor browser commands/live handles; host terminal/drain are fixtures, no historical UI or actual app restart claim")
}

func TestNativeRetainedMissingOrCorruptStoreRefusesSuccessorWithoutRepair(t *testing.T) {
	for _, fault := range []string{"missing", "claim"} {
		t.Run(fault, func(t *testing.T) {
			launch, runtime := retirementFixture(t)
			retainedNativeRetire(t, launch, runtime)
			child := filepath.Join(launch.Profile.Root, "chat", "chat-results")
			claim := filepath.Join(child, "chat-results.claim")
			if fault == "missing" {
				// Preserve the test-owned directory; only its expected name is absent.
				if err := os.Rename(child, child+"-withheld"); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(claim, []byte("corrupt controlled claim"), 0600); err != nil {
				t.Fatal(err)
			}
			launch.StoreMode, launch.PreviousHostDrainConfirmed = "open", true
			launch.HostLifetimeID, launch.ChildLaunchID = "host-2", "child-2"
			next, err := NewNativeRuntime(context.Background(), launch, "generation-2")
			if next != nil {
				next.Close()
				t.Fatal("invalid result store admitted successor")
			}
			if err == nil {
				t.Fatal("missing storage refusal")
			}
			if fault == "missing" {
				if _, err := os.Lstat(child); !os.IsNotExist(err) {
					t.Fatal("open recreated missing result store", err)
				}
			} else if got, err := os.ReadFile(claim); err != nil || string(got) != "corrupt controlled claim" {
				t.Fatal("open repaired corrupt result claim", err)
			}
		})
	}
}
